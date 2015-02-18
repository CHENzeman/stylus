// This happens right away, sometimes so fast that the content script isn't even ready. That's
// why the content script also asks for this stuff.
chrome.webNavigation.onCommitted.addListener(function(data) {
	// Until Chrome 41, we can't target a frame with a message
	// (https://developer.chrome.com/extensions/tabs#method-sendMessage)
	// so a style affecting a page with an iframe will affect the main page as well.
	// Skip doing this for frames for now, which can result in flicker.
	if (data.frameId != 0) {
		return;
	}
	getStyles({matchUrl: data.url, enabled: true, asHash: true}, function(styleHash) {
		chrome.tabs.sendMessage(data.tabId, {method: "styleApply", styles: styleHash});
		// Don't show the badge for frames
		if (data.frameId == 0) {
			chrome.browserAction.setBadgeText({text: getBadgeText(Object.keys(styleHash)), tabId: data.tabId});
		}
	});
});

chrome.extension.onMessage.addListener(function(request, sender, sendResponse) {
	switch (request.method) {
		case "getStyles":
			getStyles(request, sendResponse);
			return true;
		case "saveStyle":
			saveStyle(request, sendResponse);
			return true;
		case "styleChanged":
			cachedStyles = null;
			break;
		case "healthCheck":
			getDatabase(function() { sendResponse(true); }, function() { sendResponse(false); });
			break;
	}
});

function getStyles(options, callback) {

	var enabled = fixBoolean(options.enabled);
	var url = "url" in options ? options.url : null;
	var id = "id" in options ? options.id : null;
	var matchUrl = "matchUrl" in options ? options.matchUrl : null;
	// Return as a hash from style to applicable sections? Can only be used with matchUrl.
	var asHash = "asHash" in options ? options.asHash : false;

	var callCallback = function() {
		var styles = asHash ? {} : [];
		cachedStyles.forEach(function(style) {
			if (enabled != null && fixBoolean(style.enabled) != enabled) {
				return;
			}
			if (url != null && style.url != url) {
				return;
			}
			if (id != null && style.id != id) {
				return;
			}
			if (matchUrl != null) {
				var applicableSections = getApplicableSections(style, matchUrl);
				if (applicableSections.length > 0) {
					if (asHash) {
						styles[style.id] = applicableSections;
					} else {
						styles.push(style)
					}
				}
			} else {
				styles.push(style);
			}
		});
		callback(styles);
	}

	if (cachedStyles) {
		callCallback();
		return;
	}

	getDatabase(function(db) {
		db.readTransaction(function (t) {
			var where = "";
			var params = [];

			t.executeSql('SELECT DISTINCT s.*, se.id section_id, se.code, sm.name metaName, sm.value metaValue FROM styles s LEFT JOIN sections se ON se.style_id = s.id LEFT JOIN section_meta sm ON sm.section_id = se.id WHERE 1' + where + ' ORDER BY s.id, se.id, sm.id', params, function (t, r) {
				cachedStyles = [];
				var currentStyle = null;
				var currentSection = null;
				for (var i = 0; i < r.rows.length; i++) {
					var values = r.rows.item(i);
					var metaName = null;
					switch (values.metaName) {
						case null:
							break;
						case "url":
							metaName = "urls";
							break;
						case "url-prefix":
							metaName = "urlPrefixes";
							break;
						case "domain":
							var metaName = "domains";
							break;
						case "regexps":
							var metaName = "regexps";
							break;
						default:
							var metaName = values.metaName + "s";
					}
					var metaValue = values.metaValue;
					if (currentStyle == null || currentStyle.id != values.id) {
						currentStyle = {id: values.id, url: values.url, updateUrl: values.updateUrl, md5Url: values.md5Url, name: values.name, enabled: values.enabled, originalMd5: values.originalMd5, sections: []};
						cachedStyles.push(currentStyle);
					}
					if (values.section_id != null) {
						if (currentSection == null || currentSection.id != values.section_id) {
							currentSection = {id: values.section_id, code: values.code};
							currentStyle.sections.push(currentSection);
						}
						if (metaName && metaValue) {
							if (currentSection[metaName]) {
								currentSection[metaName].push(metaValue);
							} else {
								currentSection[metaName] = [metaValue];
							}
						}
					}
				}
				callCallback();
			}, reportError);
		}, reportError);
	}, reportError);
}

function fixBoolean(b) {
	if (typeof b != "undefined") {
		return b != "false";
	}
	return null;
}

const namespacePattern = /^\s*(@namespace[^;]+;\s*)+$/;
function getApplicableSections(style, url) {
	var sections = style.sections.filter(function(section) {
		return sectionAppliesToUrl(section, url);
	});
	// ignore if it's just namespaces
	if (sections.length == 1 && namespacePattern.test(sections[0].code)) {
		return [];
	}
	return sections;
}

function sectionAppliesToUrl(section, url) {
	// only http, https, file, and chrome-extension allowed
	if (url.indexOf("http") != 0 && url.indexOf("file") != 0 && url.indexOf("chrome-extension") != 0) {
		return false;
	}
	if (!section.urls && !section.domains && !section.urlPrefixes && !section.regexps) {
		//console.log(section.id + " is global");
		return true;
	}
	if (section.urls && section.urls.indexOf(url) != -1) {
		//console.log(section.id + " applies to " + url + " due to URL rules");
		return true;
	}
	if (section.urlPrefixes && section.urlPrefixes.some(function(prefix) {
		return url.indexOf(prefix) == 0;
	})) {
		//console.log(section.id + " applies to " + url + " due to URL prefix rules");
		return true;
	}
	if (section.domains && getDomains(url).some(function(domain) {
		return section.domains.indexOf(domain) != -1;
	})) {
		//console.log(section.id + " applies due to " + url + " due to domain rules");
		return true;
	}
	if (section.regexps && section.regexps.some(function(regexp) {
		// we want to match the full url, so add ^ and $ if not already present
		if (regexp[0] != "^") {
			regexp = "^" + regexp;
		}
		if (regexp[regexp.length - 1] != "$") {
			regexp += "$";
		}
		try {
			var re = new RegExp(regexp);
		} catch (ex) {
			console.log(section.id + "'s regexp '" + regexp + "' is not valid");
			return false;
		}
		return (re).test(url);
	})) {
		//console.log(section.id + " applies to " + url + " due to regexp rules");
		return true;
	}
	//console.log(section.id + " does not apply due to " + url);
	return false;
}

var cachedStyles = null;

function saveStyle(o, callback) {
	getDatabase(function(db) {
		db.transaction(function(t) {
			if (o.id) {
				// update whatever's been passed
				if ("name" in o) {
					t.executeSql('UPDATE styles SET name = ? WHERE id = ?;', [o.name, o.id]);
				}
				if ("enabled" in o) {
					t.executeSql('UPDATE styles SET enabled = ? WHERE id = ?;', [o.enabled, o.id]);
				}
				if ("url" in o) {
					t.executeSql('UPDATE styles SET url = ? WHERE id = ?;', [o.url, o.id]);
				}
				if ("updateUrl" in o) {
					t.executeSql('UPDATE styles SET updateUrl = ? WHERE id = ?;', [o.updateUrl, o.id]);
				}
				if ("md5Url" in o) {
					t.executeSql('UPDATE styles SET md5Url = ? WHERE id = ?;', [o.md5Url, o.id]);
				}
				if ("originalMd5" in o) {
					t.executeSql('UPDATE styles SET originalMd5 = ? WHERE id = ?;', [o.originalMd5, o.id]);
				}
			} else {
				// create a new record
				// set optional things to null if they're undefined
				["updateUrl", "md5Url", "url", "originalMd5"].filter(function(att) {
					return !(att in o);
				}).forEach(function(att) {
					o[att] = null;
				});
				t.executeSql('INSERT INTO styles (name, enabled, url, updateUrl, md5Url, originalMd5) VALUES (?, ?, ?, ?, ?, ?);', [o.name, true, o.url, o.updateUrl, o.md5Url, o.originalMd5]);
			}

			if ("sections" in o) {
				if (o.id) {
					// clear existing records
					t.executeSql('DELETE FROM section_meta WHERE section_id IN (SELECT id FROM sections WHERE style_id = ?);', [o.id]);
					t.executeSql('DELETE FROM sections WHERE style_id = ?;', [o.id]);
				}

				o.sections.forEach(function(section) {
					if (o.id) {
						t.executeSql('INSERT INTO sections (style_id, code) VALUES (?, ?);', [o.id, section.code]);
					} else {
						t.executeSql('INSERT INTO sections (style_id, code) SELECT id, ? FROM styles ORDER BY id DESC LIMIT 1;', [section.code]);
					}
					if (section.urls) {
						section.urls.forEach(function(u) {
							t.executeSql("INSERT INTO section_meta (section_id, name, value) SELECT id, 'url', ? FROM sections ORDER BY id DESC LIMIT 1;", [u]);
						});
					}
					if (section.urlPrefixes) {
						section.urlPrefixes.forEach(function(u) {
							t.executeSql("INSERT INTO section_meta (section_id, name, value) SELECT id, 'url-prefix', ? FROM sections ORDER BY id DESC LIMIT 1;", [u]);
						});
					}
					if (section.domains) {
						section.domains.forEach(function(u) {
							t.executeSql("INSERT INTO section_meta (section_id, name, value) SELECT id, 'domain', ? FROM sections ORDER BY id DESC LIMIT 1;", [u]);
						});
					}
					if (section.regexps) {
						section.regexps.forEach(function(u) {
							t.executeSql("INSERT INTO section_meta (section_id, name, value) SELECT id, 'regexp', ? FROM sections ORDER BY id DESC LIMIT 1;", [u]);
						});
					}
				});
			}
		}, reportError, function() {saveFromJSONComplete(o.id, callback)});
	}, reportError);
}

function saveFromJSONComplete(id, callback) {
	cachedStyles = null;

	if (id) {
		getStyles({method: "getStyles", id: id}, function(styles) {
			saveFromJSONStyleReloaded("styleUpdated", styles[0], callback);
		});
		return;
	}

	// we need to load the id for new ones
	getDatabase(function(db) {
		db.readTransaction(function (t) {
			t.executeSql('SELECT id FROM styles ORDER BY id DESC LIMIT 1', [], function(t, r) {
				var id = r.rows.item(0).id;
				getStyles({method: "getStyles", id: id}, function(styles) {
					saveFromJSONStyleReloaded("styleAdded", styles[0], callback);
				});
			}, reportError)
		}, reportError)
	});

}

function saveFromJSONStyleReloaded(updateType, style, callback) {
	notifyAllTabs({method: updateType, style: style});
	if (callback) {
		callback(style);
	}
}

// Get the DB so that any first run actions will be performed immediately when the background page loads.
getDatabase(function() {}, reportError);

// When an edit page gets attached or detached, remember its state so we can do the same to the next one to open.
var editFullUrl = chrome.extension.getURL("edit.html");
chrome.tabs.onAttached.addListener(function(tabId, data) {
	chrome.tabs.get(tabId, function(tabData) {
		if (tabData.url.indexOf(editFullUrl) == 0) {
			chrome.windows.get(tabData.windowId, {populate: true}, function(win) {
				// If there's only one tab in this window, it's been dragged to new window
				localStorage['openEditInWindow'] = win.tabs.length == 1 ? "true" : "false";
			});
		}
	});
});
