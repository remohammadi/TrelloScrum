/*
** Bazaar Agile for Trello
** https://github.com/remohammadi/TrelloScrum
** Adds Scrum & Kanban tools to your Trello, in Bazaar flavor
**
** Reza Mohammadi <reza@cafebazaar.ir>
**
** Forked from https://github.com/Q42/TrelloScrum
** Jasper Kaizer <https://github.com/jkaizer>
** Marcel Duin <https://github.com/marcelduin>
**
** Contribs:
** Paul Lofte <https://github.com/paullofte>
** Nic Pottier <https://github.com/nicpottier>
** Bastiaan Terhorst <https://github.com/bastiaanterhorst>
** Morgan Craft <https://github.com/mgan59>
** Frank Geerlings <https://github.com/frankgeerlings>
** Cedric Gatay <https://github.com/CedricGatay>
** Kit Glennon <https://github.com/kitglen>
** Samuel Gaus <https://github.com/gausie>
** Sean Colombo <https://github.com/seancolombo>
**
*/


// ===========================================================================
// Constants
// ===========================================================================
var DEBUG = false;

// For MutationObserver
var OBS_CONFIG = { childList: true, characterData: true, attributes: false, subtree: true };

//default story point picker sequence (can be overridden in the Scrum for Trello 'Settings' popup)
var _pointSeq = ['?', 0, .5, 1, 2, 3, 5, 8, 13, 21];
//attributes representing points values for card
var _pointsAttr = ['cpoints', 'points'];

// All settings and their defaults.
var SETTING_NAME_ESTIMATES = "estimatesSequence";
var S4T_ALL_SETTINGS = [SETTING_NAME_ESTIMATES];
var S4T_SETTING_DEFAULTS = {};
S4T_SETTING_DEFAULTS[SETTING_NAME_ESTIMATES] = _pointSeq.join();

var P_RE = /((?:^|\s))\((\x3f|\d*\.?\d+)(\))\s?/m, //parse regexp- accepts digits, decimals and '?', surrounded by ()
    C_RE = /((?:^|\s))\[(\x3f|\d*\.?\d+)(\])\s?/m, //parse regexp- accepts digits, decimals and '?', surrounded by []
    L_RE = /((?:^|\s))<(\x3f|\d*\.?\d+)(>)\s?/m, //parse regexp- accepts digits, decimals and '?', surrounded by <>
    iconUrl, pointsDoneUrl,
    scrumLogoUrl, scrumLogo18Url;
if(typeof chrome !== 'undefined'){
    // Works in Chrome
	iconUrl = chrome.extension.getURL('images/storypoints-icon.png');
	pointsDoneUrl = chrome.extension.getURL('images/points-done.png');
	scrumLogoUrl = chrome.extension.getURL('images/trello-scrum-icon_12x12.png');
	scrumLogo18Url = chrome.extension.getURL('images/trello-scrum-icon_18x18.png');
} else if(navigator.userAgent.indexOf('Safari') != -1){ // Chrome defines both "Chrome" and "Safari", so this test MUST be done after testing for Chrome
	// Works in Safari
	iconUrl = safari.extension.baseURI + 'images/storypoints-icon.png';
	pointsDoneUrl = safari.extension.baseURI + 'images/points-done.png';
	scrumLogoUrl = safari.extension.baseURI + 'images/trello-scrum-icon_12x12.png';
	scrumLogo18Url = safari.extension.baseURI + 'images/trello-scrum-icon_18x18.png';
} else {
	// Works in Firefox Add-On
	if(typeof self.options != 'undefined'){ // options defined in main.js
		iconUrl = self.options.iconUrl;
		pointsDoneUrl = self.options.pointsDoneUrl;
		scrumLogoUrl = self.options.scrumLogoUrl;
		scrumLogo18Url = self.options.scrumLogo18Url;
	}
}


// ===========================================================================
// Variables
// ===========================================================================
var trelloBoardName = (/^\/b\/(\w+)\//).exec(window.location.pathname);
if (trelloBoardName) {
    trelloBoardName = trelloBoardName[1];
} else {
    trelloBoardName = undefined;
}
var S4T_SETTINGS = [];


// ===========================================================================
// Methods
// ===========================================================================
// Thanks @unscriptable - http://unscriptable.com/2009/03/20/debouncing-javascript-methods/
var debounce = function (func, threshold, execAsap) {
    var timeout;
    return function debounced () {
    	var obj = this, args = arguments;
		function delayed () {
			if (!execAsap)
				func.apply(obj, args);
			timeout = null; 
		};

		if (timeout)
			clearTimeout(timeout);
		else if (execAsap)
			func.apply(obj, args);

		timeout = setTimeout(delayed, threshold || 100);
	};
}

// To correct direction for RTL languages
var apply_rtl_if_needed = function(event) {
    var text = $(this).text();
    var n = text.length;

    var rtl = 0;
    var ltr = 0;
    for ( var i = 0; i < n; i ++ ) {
        var char = text[i];
	    if ((char >= 'A') && (char <= 'z')) {
            ltr += 1;
        } else if ((char >= '؀') && (char <= 'ۿ')) {
            rtl += 1;
        } else if ((char >= '׀') && (char <= '״')) {
            rtl += 1;
        }
        if ((rtl + ltr) > 256)
            break;
    }

    if (rtl > ltr) {
        $(this).css({
            direction: "rtl"
        });
    } else {
        $(this).css({
            direction: "ltr"
        });
    }
};

var fixDirections = debounce(function() {
    $('.markeddown').each(apply_rtl_if_needed);
    $('.window-title-text').each(apply_rtl_if_needed);
    $('.list-card-title').each(apply_rtl_if_needed);
}, 500, false);

function round(_val) {return (Math.round(_val * 100) / 100)};

// Some browsers have serious errors with MutationObserver (eg: Safari doesn't have it called MutationObserver).
var CrossBrowser = {
	init: function(){
		this.MutationObserver = window.MutationObserver || window.WebKitMutationObserver || window.MozMutationObserver || null;
	}
};
CrossBrowser.init();

// Recalculates every card and its totals (used for significant DOM modifications).
var recalcListAndTotal = debounce(function($el){
    ($el||$('.list')).each(function(){
		if(!this.list) new List(this);
		else if(this.list.refreshList){
			this.list.refreshList(); // make sure each card's points are still accurate (also calls list.calc()).
		}
	})
}, 500, false);

var recalcTotalsObserver = new CrossBrowser.MutationObserver(function(mutations) {
	// Determine if the mutation event included an ACTUAL change to the list rather than
	// a modification caused by this extension making an update to points, etc. (prevents
	// infinite recursion).
	var doFullRefresh = false;
	var refreshJustTotals = false;
	$.each(mutations, function(index, mutation){
		var $target = $(mutation.target);

		// Ignore a bunch of known cases that send mutation events which don't require us to recalcListAndTotal.
		if(! ($target.hasClass('list-total')
			  || $target.hasClass('list-title')
			  || $target.hasClass('list-header')
			  || $target.hasClass('date') // the 'time-ago' functionality changes date spans every minute
			  || $target.hasClass('js-phrase') // this is constantly updated by Trello, but doesn't affect estimates.
              || $target.hasClass('member')
              || $target.hasClass('clearfix')
              || $target.hasClass('badges')
			  || $target.hasClass('header-btn-text')
              || (typeof mutation.target.className == "undefined")
			  ))
		{
			if($target.hasClass('badge')){
                if(!$target.hasClass("consumed")){
    				refreshJustTotals = true;
                }
			} else {
				// It appears this was an actual modification and not a recursive notification.
				doFullRefresh = true;
			}
		}
	});
	
	if(doFullRefresh){
		recalcListAndTotal();
	} else if(refreshJustTotals){
		calcListPoints();
	}
    fixDirections();
    
    $editControls = $(".card-detail-title .edit-controls");
    if($editControls.length > 0)
    {
        showPointPicker($editControls.get(0));
    }
});
recalcTotalsObserver.observe(document.body, OBS_CONFIG);

// Refreshes the links on the Toolbar
function updateToolbar(){
    // Add the link for Settings
    if($('.s4tLink').length === 0){
		var buttons = "";

		// Link for settings
		buttons += "<a id='scrumSettingsLink' class='s4tLink quiet ed board-header-btn dark-hover' href='#'>";
		buttons += "<span class='icon-sm board-header-btn-icon'><img src='"+scrumLogoUrl+"' width='12' height='12' title='Settings: Scrum for Trello'/></span>";
		//buttons += "<span class='text board-header-btn-text'>Settings</span>"; // too big :-/ icon only for now
		buttons += "</a>";
		var showOnLeft = true;
		if(showOnLeft){
			$('.board-header-btns.left').last().after(buttons);
		} else {
			$('.board-header-btns.right,#board-header a').last().after(buttons);
		}
		$('#scrumSettingsLink').click(showSettings);
    }
}

var ignoreClicks = function(){ return false; };

var settingsFrameId = 'settingsFrame';
function showSettings()
{
    $('body').addClass("window-up");
    $('.window').css("display", "block").css("top", "50px");

	// Build the dialog DOM elements. There are no unescaped user-provided strings being used here.
	var clearfix = $('<div/>', {class: 'clearfix'});
	var windowHeaderUtils = $('<div/>', {class: 'window-header-utils dialog-close-button'}).append( $('<a/>', {class: 'icon-lg icon-close dark-hover js-close-window', href: '#', title:'Close this dialog window.'}) );
    var settingsIcon = $('<img/>', {style: 'position:absolute; margin-left: 20px; margin-top:15px;', src:scrumLogo18Url});

	// Create the Settings form.
	{
		// Load the current settings (with defaults in case Settings haven't been set).
		var setting_estimateSeq = S4T_SETTINGS[SETTING_NAME_ESTIMATES];
	
		var settingsDiv = $('<div/>', {style: "padding:0px 10px;font-family:'Helvetica Neue', Arial, Helvetica, sans-serif;"});
		var iframeHeader = $('<h3/>', {style: 'text-align: center;'});
		iframeHeader.text('Scrum for Trello');
		var settingsHeader = $('<h3/>', {style: 'text-align: center;margin-bottom:0px'});
		settingsHeader.text('Settings');
		var settingsInstructions = $('<div/>', {style: 'margin-bottom:10px'}).html('These settings affect how Scrum for Trello appears to <em>you</em> on all boards.  When you&apos;re done, remember to click "Save Settings" below.');
		var settingsForm = $('<form/>', {id: 'scrumForTrelloForm'});

		// Which estimate buttons should show up.
		var fieldset_estimateButtons = $('<fieldset/>', {style: 'margin-top:5px'});
		var legend_estimateButtons = $('<legend/>');
		legend_estimateButtons.text("Estimate Buttons");
		fieldset_estimateButtons.append(legend_estimateButtons);
			var explanation = $('<div/>').text("List out the values you want to appear on the estimate buttons, separated by commas. They can be whole numbers, decimals, or a question mark.");
			fieldset_estimateButtons.append(explanation);
			
			var estimateFieldId = 'pointSequenceToUse';
			var estimateField = $('<input/>', {id: estimateFieldId, size: 40, val: setting_estimateSeq});
			fieldset_estimateButtons.append(estimateField);
			
			var titleTextStr = "Original sequence is: " + _pointSeq.join();
			var restoreDefaultsButton = $('<button/>')
											.text('restore to original values')
											.attr('title', titleTextStr)
											.click(function(e){
												e.preventDefault();
												$('#'+settingsFrameId).contents().find('#'+estimateFieldId).val(_pointSeq.join());
											});
			fieldset_estimateButtons.append(restoreDefaultsButton);

		var saveButton = $('<button/>', {style:'margin-top:5px'}).text('Save Settings').click(function(e){
			e.preventDefault();

			// Save the settings (persists them using Chrome cloud, LocalStorage, or Cookies - in that order of preference if available).
			S4T_SETTINGS[SETTING_NAME_ESTIMATES] = $('#'+settingsFrameId).contents().find('#'+estimateFieldId).val();

			// Persist all settings.
			$.each(S4T_ALL_SETTINGS, function(i, settingName){
				saveSetting(settingName, S4T_SETTINGS[settingName]);
			});

			// Allow the UI to update itself as needed.
			onSettingsUpdated();
		});
		var savedIndicator = $('<span/>', {id: 's4tSaved', style: 'color:#080;background-color:#afa;font-weight:bold;display:none;margin-left:10px'})
									.text("Saved!");

		// Set up the form (all added down here to be easier to change the order).
		settingsForm.append(fieldset_estimateButtons);
		settingsForm.append(saveButton);
		settingsForm.append(savedIndicator);
	}
	
	// Quick start instructions.
	var quickStartDiv = $('<div>\
		<h4 style="margin-top:0px;margin-bottom:0px">Getting started</h4>\
		<ol style="margin-top:0px">\
			<li>To add an estimate to a card, first <strong>click a card</strong> to open it</li>\
			<li><strong>Click the title of the card</strong> to "edit" the title.</li>\
			<li>Once the Card title is in edit-mode, blue number buttons will appear. <strong>Click one of the buttons</strong> to set that as the estimate.</li>\
		</ol>\
	</div>');

	var moreInfoLink = $('<small>For more information, see <a href="http://scrumfortrello.com">ScrumForTrello.com</a></small>');

	// Add each of the components to build the iframe (all done here to make it easier to re-order them).
	settingsDiv.append(iframeHeader);
	settingsDiv.append(quickStartDiv);
	settingsDiv.append(settingsHeader);
	settingsDiv.append(settingsInstructions);
	settingsDiv.append(settingsForm);
	settingsDiv.append(moreInfoLink);

	// Trello swallows normal input, so things like checkboxes and radio buttons don't work right... so we stuff everything in an iframe.
	var iframeObj = $('<iframe/>', {frameborder: '0',
						 style: 'width: 670px; height: 528px;', /* 512 was fine on Chrome, but FF requires 528 to avoid scrollbars */
						 id: settingsFrameId,
	});
	$windowWrapper = $('.window-wrapper');
    $windowWrapper.click(ignoreClicks);
	$windowWrapper.empty().append(clearfix).append(settingsIcon).append(windowHeaderUtils);

	iframeObj.appendTo($windowWrapper);

	// Firefox wil load the iframe (even if there is no 'src') and overwrite the existing HTML, so we've
	// reworked this to load about:blank then set our HTML upon load completion.
	iframeObj.load(function(){
		iframeObj.contents().find('body').append(settingsDiv);
	});
	iframeObj.attr('src', "about:blank"); // need to set this AFTER the .load() has been registered.
}

//calculate board totals
var ctto;
function computeTotal(){
	clearTimeout(ctto);
	ctto = setTimeout(function(){
		var $title = $('.board-header-btns.right,#board-header a');
		var $total = $title.children('.list-total').empty();
		if ($total.length == 0)
			$total = $('<span/>', {class: "list-total"}).appendTo($title);

		for (var i in _pointsAttr){
			var score = 0,
				attr = _pointsAttr[i];
			$('#board .list-total .'+attr).each(function(){
				score+=parseFloat(this.textContent)||0;
			});
			var scoreSpan = $('<span/>', {class: attr}).text(round(score)||'');
			$total.append(scoreSpan);
		}
        
        updateToolbar();
	});
};

//calculate list totals
var lto;
function calcListPoints(){
	clearTimeout(lto);
	lto = setTimeout(function(){
		$('.list').each(function(){
			if(!this.list) new List(this);
			else if(this.list.calc) this.list.calc();
		});
	});
};

//.list pseudo
function List(el){
	if(el.list)return;
	el.list=this;

	var $list=$(el),
		$total=$('<span class="list-total">'),
		busy = false,
        kanbanLimit = NaN,
		to,
		to2;

	function readCard($c){
		if($c.target) {
			if(!/list-card/.test($c.target.className)) return;
			$c = $($c.target).filter('.list-card:not(.placeholder)');
		}
		$c.each(function(){
			if(!this.listCard) for (var i in _pointsAttr)
				new ListCard(this,_pointsAttr[i]);
			else for (var i in _pointsAttr)
				setTimeout(this.listCard[_pointsAttr[i]].refresh);
		});
	};

	var self = this;
	this.refresh = debounce(function(){
		self._refreshInner();
    }, 250, true); // executes right away unless over its 250ms threshold
	this._refreshInner=function(){
		var $title=$list.find('h2.list-header-name');
		if(!$title[0])return;
		var titleTextContent = $title[0].textContent;
		if(titleTextContent) el._title = titleTextContent;
		parsed=titleTextContent.match(L_RE);
		kanbanLimit=parsed?parsed[2]:NaN;
        if (DEBUG) {
            console.log("Extracting kanbanLimit=" + kanbanLimit + ", from " + titleTextContent);
        }
    }

	// All calls to calc are throttled to happen no more than once every 500ms (makes page-load and recalculations much faster).
	this.calc = debounce(function(){
		self._calcInner();
    }, 500, true); // executes right away unless over its 500ms threshold since the last execution
	this._calcInner	= function(e){ // don't call this directly. Call calc() instead.
		//if(e&&e.target&&!$(e.target).hasClass('list-card')) return; // TODO: REMOVE - What was this? We never pass a param into this function.
		clearTimeout(to);
		to = setTimeout(function(){
			$total.empty().appendTo($list.find('.list-title,.list-header'));
			for (var i in _pointsAttr){
				var score=0,
					attr = _pointsAttr[i];
				$list.find('.list-card:not(.placeholder)').each(function(){
					if(!this.listCard) return;
					if(!isNaN(Number(this.listCard[attr].points))){
						// Performance note: calling :visible in the selector above leads to noticible CPU usage.
						if(jQuery.expr.filters.visible(this)){
							score+=Number(this.listCard[attr].points);
						}
					}
				});
				var scoreTruncated = round(score);
				var scoreSpan = $('<span/>', {class: attr}).text( (scoreTruncated>0) ? scoreTruncated : '' );
				$total.append(scoreSpan);
			}
			computeTotal();

            if (!isNaN(kanbanLimit)) {
                var score = 0;
				$list.find('.list-card:not(.placeholder)').each(function(){
					if (!this.listCard) return;
					if (!isNaN(Number(this.listCard['points'].points))){
						// Performance note: calling :visible in the selector above leads to noticible CPU usage.
                        if (jQuery.expr.filters.visible(this)){
                            if (this.listCard['points'].points === '') {
                                score += 1; // If no estimate, count them as 1.0
                            } else {
                                score += Number(this.listCard['points'].points);
                            }
						}
					}
				});
                if (DEBUG) {
                    console.log("score=" + score + ", kanbanLimit=" + kanbanLimit)
                }
                if (score > kanbanLimit) {
                    $list.addClass('kanban-overflow');
                } else {
                    $list.removeClass('kanban-overflow');
                }
            }
		});
	};
    
    this.refreshList = debounce(function(){
    		readCard($list.find('.list-card:not(.placeholder)'));
            this.calc(); // readCard will call this.calc() if any of the cards get refreshed.
    }, 500, false);

	var cardAddedRemovedObserver = new CrossBrowser.MutationObserver(function(mutations)
	{
		// Determine if the mutation event included an ACTUAL change to the list rather than
		// a modification caused by this extension making an update to points, etc. (prevents
		// infinite recursion).
		$.each(mutations, function(index, mutation){
			var $target = $(mutation.target);
			
			// Ignore a bunch of known elements that send mutation events.
			if(! ($target.hasClass('list-total')
					|| $target.hasClass('list-title')
					|| $target.hasClass('list-header')
					|| $target.hasClass('badge-points')
					|| $target.hasClass('badges')
					|| (typeof mutation.target.className == "undefined")
					))
			{
				var list;
				// It appears this was an actual mutation and not a recursive notification.
				$list = $target.closest(".list");
				if($list.length > 0){
					list = $list.get(0).list;
					if(!list){
						list = new List(mutation.target);
					}
					if(list){
						list.refreshList(); // debounced, so its safe to call this multiple times for the same list in this loop.
					}
				}
			}
		});
	});

    cardAddedRemovedObserver.observe($list.get(0), OBS_CONFIG);

	var listObserver = new CrossBrowser.MutationObserver(function(mutations){
        setTimeout(self.refresh);
    });
    var $el_title = $list.find('h2.list-header-name').get(0);
    if ($el_title) {
        listObserver.observe($el_title, {childList: true, characterData: false,
            attributes: false, subtree: false});

        setTimeout(self.refresh);
    }

	setTimeout(function(){
		readCard($list.find('.list-card'));
		setTimeout(el.list.calc);
	});
};

//.list-card pseudo
function ListCard(el, identifier){
	if(el.listCard && el.listCard[identifier]) return;

	//lazily create object
	if (!el.listCard){
		el.listCard={};
	}
	el.listCard[identifier]=this;

	var points=-1,
		consumed=identifier!=='points',
		regexp=consumed?C_RE:P_RE,
		parsed,
		that=this,
		busy=false,
		$card=$(el),
		$badge=$('<div class="badge badge-points point-count" style="background-image: url('+iconUrl+')"/>'),
		to,
		to2;

	// MutationObservers may send a bunch of similar events for the same card (also depends on browser) so
	// refreshes are debounced now.
	var self = this;
	this.refresh = debounce(function(){
		self._refreshInner();
    }, 250, true); // executes right away unless over its 250ms threshold
	this._refreshInner=function(){
		if(busy) return;
		busy = true;
		clearTimeout(to);
		to = setTimeout(function(){
			var $title=$card.find('a.list-card-title');
			if(!$title[0])return;
			var titleTextContent = $title[0].childNodes[1].textContent;
			if(titleTextContent) el._title = titleTextContent;
			
			// Get the stripped-down (parsed) version without the estimates, that was stored after the last change.
			var parsedTitle = $title.data('parsed-title'); 
			if(titleTextContent != parsedTitle){
				// New card title, so we have to parse this new info to find the new amount of points.
				parsed=titleTextContent.match(regexp);
				points=parsed?parsed[2]:-1;
			} else {
				// Title text has already been parsed... process the pre-parsed title to get the correct points.
				var origTitle = $title.data('orig-title');
				parsed=origTitle.match(regexp);
				points=parsed?parsed[2]:-1;
			}

			clearTimeout(to2);
			to2 = setTimeout(function(){
				// Add the badge (for this point-type: regular or consumed) to the badges div.
				$badge
					.text(that.points)
					[(consumed?'add':'remove')+'Class']('consumed')
					.attr({title: 'This card has '+that.points+ (consumed?' consumed':'')+' storypoint' + (that.points == 1 ? '.' : 's.')})
					.prependTo($card.find('.badges'));

				// Update the DOM element's textContent and data if there were changes.
				if(titleTextContent != parsedTitle){
					$title.data('orig-title', titleTextContent); // store the non-mutilated title (with all of the estimates/time-spent in it).
				}
				parsedTitle = $.trim(el._title.replace(P_RE,'$1').replace(C_RE,'$1'));
				el._title = parsedTitle;
				$title.data('parsed-title', parsedTitle); // save it to the DOM element so that both badge-types can refer back to it.
				$title[0].childNodes[1].textContent = parsedTitle;
				var list = $card.closest('.list');
				if(list[0]){
					list[0].list.calc();
				}
				busy = false;
			});
		});
	};

	this.__defineGetter__('points',function(){
		return parsed?points:''
	});

	var cardShortIdObserver = new CrossBrowser.MutationObserver(function(mutations){
		$.each(mutations, function(index, mutation){
			var $target = $(mutation.target);
			if(mutation.addedNodes.length > 0){
				$.each(mutation.addedNodes, function(index, node){
					if($(node).hasClass('card-short-id')){
						// Found a card-short-id added to the DOM. Need to refresh this card.
						var listElement = $target.closest('.list').get(0);
						if(!listElement.list) new List(listElement); // makes sure the .list in the DOM has a List object

						var $card = $target.closest('.list-card');
						if($card.length > 0){
							var listCardHash = $card.get(0).listCard;
							if(listCardHash){
								// The hash contains a ListCard object for each type of points (cpoints, points, possibly more in the future).
								$.each(_pointsAttr, function(index, pointsAttr){
									listCardHash[pointsAttr].refresh();
								});
							}
						}
					}
				});
			}
		});
	});

	// The MutationObserver is only attached once per card (for the non-consumed-points ListCard) and that Observer will make the call
	// to update BOTH types of points-badges.
	if(!consumed){
		var observerConfig = { childList: true, characterData: false, attributes: false, subtree: true };
		cardShortIdObserver.observe(el, observerConfig);
	}

	setTimeout(that.refresh);
};

//the story point picker
function showPointPicker(location) {
	if($(location).find('.picker').length) return;
	var $picker = $('<div/>', {class: "picker"}).appendTo('.card-detail-title .edit-controls');
	$picker.append($('<span>', {class: "picker-title"}).text("Estimated Points"));
	
	var estimateSequence = (S4T_SETTINGS[SETTING_NAME_ESTIMATES].replace(/ /g, '')).split(',');
	for (var i in estimateSequence) $picker.append($('<span>', {class: "point-value"}).text(estimateSequence[i]).click(function(){
		var value = $(this).text();
		var $text = $('.card-detail-title .edit textarea');
		var text = $text.val();

		// replace our new
		$text[0].value=text.match(P_RE)?text.replace(P_RE, '('+value+') '):'('+value+') ' + text;

		// then click our button so it all gets saved away
		$(".card-detail-title .edit .js-save-edit").click();

		return false
	}))
	
	if($(location).find('.picker-consumed').length) return;
	var $pickerConsumed = $('<div/>', {class: "picker-consumed"}).appendTo('.card-detail-title .edit-controls');
	$pickerConsumed.append($('<span>', {class: "picker-title"}).text("Consumed Points"));

	var consumedSequence = (S4T_SETTINGS[SETTING_NAME_ESTIMATES]).split(',');
	for (var i in consumedSequence) $pickerConsumed.append($('<span>', {class: "point-value"}).text(consumedSequence[i]).click(function(){
		var value = $(this).text();
		var $text = $('.card-detail-title .edit textarea');
		var text = $text.val();

		// replace our new
		$text[0].value=text.match(C_RE)?text.replace(C_RE, ' ['+value+']'):text + ' ['+value+']';

		// then click our button so it all gets saved away
		$(".card-detail-title .edit .js-save-edit").click();

		return false
	}))
};


//for export
var $excel_btn,$excel_dl;
window.URL = window.webkitURL || window.URL;

function checkExport() {
	if($excel_btn && $excel_btn.filter(':visible').length) return;
	if($('.pop-over-list').find('.js-export-excel').length) return;
	var $js_btn = $('.pop-over-list').find('.js-export-json');
	var $ul = $js_btn.closest('ul:visible');
	if(!$js_btn.length) return;
	$js_btn.parent().after($('<li>').append(
		$excel_btn = $('<a href="#" target="_blank" title="Open downloaded file with Excel">Excel</a>')
			.click(showExcelExport)
		))
};

function showExcelExport() {
	$excel_btn.text('Generating...');

	$.getJSON($('.pop-over-list').find('.js-export-json').attr('href'), function(data) {
		var s = '<table id="export" border=1>';
		s += '<tr><th>Points</th><th>Story</th><th>Description</th></tr>';
		$.each(data['lists'], function(key, list) {
			var list_id = list["id"];
			s += '<tr><th colspan="3">' + list['name'] + '</th></tr>';

			$.each(data["cards"], function(key, card) {
				if (card["idList"] == list_id) {
					var title = card["name"];
					var parsed = title.match(P_RE);
					var points = parsed?parsed[1]:'';
					title = title.replace(P_RE,'');
					s += '<tr><td>'+ points + '</td><td>' + title + '</td><td>' + card["desc"] + '</td></tr>';
				}
			});
			s += '<tr><td colspan=3></td></tr>';
		});
		s += '</table>';

		var blob = new Blob([s],{type:'application/ms-excel'});

		var board_title_reg =  /.*\/(.*)$/;
		var board_title_parsed = document.location.href.match(board_title_reg);
		var board_title = board_title_parsed[1];

		$excel_btn
			.text('Excel')
			.after(
				$excel_dl=$('<a>')
					.attr({
						download: board_title + '.xls',
						href: window.URL.createObjectURL(blob)
					})
			);

		var evt = document.createEvent('MouseEvents');
		evt.initMouseEvent('click', true, true, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
		$excel_dl[0].dispatchEvent(evt);
		$excel_dl.remove()

	});

	return false
};

// for settings

function useChromeStorage(){
	return ((typeof chrome !== "undefined") && (typeof chrome.storage !== "undefined"));
}

/**
 * Saves the Setting (defined by 'settingName') to be whatever is in 'settingValue'.
 *
 * This will use Chrome cloud-storage if available, then will fall back to LocalStorage
 * if possible and fall back to cookies otherwise.
 *
 * NOTE: Remember to enver store confidential or user information in Chrome cloud
 * storage (it's not encrypted).
 */
function saveSetting(settingName, settingValue){
	// Use Chrome cloud storage where available (will sync across multiple computers).
	if(useChromeStorage()){
		var objectToPersist = {}; // can't use an object-literal to do it, or chrome will make an object whose key is literally 'settingName'
		objectToPersist[settingName] = settingValue;
		chrome.storage.sync.set(objectToPersist, function() {
		});
	} else if(typeof(Storage) !== "undefined"){
		localStorage[settingName] = settingValue;
	} else {
		// No LocalStorage support... use cookies instead.
		setCookie(settingName, settingValue);
	}
} // end saveSetting()

/**
 * Retrieves the Setting defined by 'settingName'. The 'defaultValue' is optional.
 *
 * This will use LocalStorage if possible and fall back to cookies otherwise. Typically
 * this function will only be used if Chrome cloud storage is not available.
 */
function getSetting(settingName, defaultValue){
	var retVal = defaultValue;
	if(typeof(Storage) !== "undefined"){
		var lsValue = localStorage[settingName];
		if(typeof lsValue !== 'undefined'){
			retVal = lsValue;
		}
	} else {
		// No LocalStorage support... use cookies instead.
		retVal = getCookie(settingName, defaultValue);
	}
	return retVal;
}; // end getSetting()

/**
 * Refreshes all of the persisted settings and puts them in memory. This is
 * done at the beginning, and any time chrome cloud-storage sends an event
 * that the data has changed.
 */
function refreshSettings(){
	if(useChromeStorage()){
		chrome.storage.sync.get(S4T_ALL_SETTINGS, function(result){
			//if(chrome.runtime.lastError){}
			$.each(S4T_ALL_SETTINGS, function(i, settingName){
				if(result[settingName]){
					S4T_SETTINGS[settingName] = result[settingName];
				} else {
					S4T_SETTINGS[settingName] = S4T_SETTING_DEFAULTS[settingName];
				}
			});
			onSettingsUpdated();
		});
	} else {
		// Get the settings (with defaults for each). Add a new line here for every new setting.
		$.each(S4T_ALL_SETTINGS, function(i, settingName){
			S4T_SETTINGS[settingName] = getSetting(settingName, S4T_SETTING_DEFAULTS[settingName]);
		});
		onSettingsUpdated();
	}
}; // end refreshSettings()

function onSettingsUpdated(){
	// Temporary indication to the user that the settings were saved (might not always be on screen, but that's not a problem).
	$('#'+settingsFrameId).contents().find('#s4tSaved').show().fadeOut(2000, "linear");
	
	// Refresh the links because link-settings may have changed.
	$('.s4tLink').remove();
	updateToolbar();
} // end onSettingsUpdated()

/**
 * Sets a key/value cookie to live for about a year. Cookies are typically not used by
 * this extension if LocalSettings is available in the browser.
 * From: http://www.w3schools.com/js/js_cookies.asp
 */
function setCookie(c_name,value){
	var exdays = 364;
	var exdate=new Date();
	exdate.setDate(exdate.getDate() + exdays);
	var c_value=escape(value) + ((exdays==null) ? "" : "; expires="+exdate.toUTCString());
	document.cookie=c_name + "=" + c_value;
}; // end setCookie()

/**
 * Gets a cookie value if available (defaultValue if not found). Cookies are typically not\
 * used by this extension if LocalSettings is available in the browser.
 * Basically from: http://www.w3schools.com/js/js_cookies.asp
 */
function getCookie(c_name, defaultValue){
	var c_value = document.cookie;
	var c_start = c_value.indexOf(" " + c_name + "=");
	if (c_start == -1){
		c_start = c_value.indexOf(c_name + "=");
	}
	if (c_start == -1){
		c_value = defaultValue;
	} else {
		c_start = c_value.indexOf("=", c_start) + 1;
		var c_end = c_value.indexOf(";", c_start);
		if (c_end == -1) {
			c_end = c_value.length;
		}
		c_value = unescape(c_value.substring(c_start,c_end));
	}
	return c_value;
}; // end getCookie()


// ===========================================================================
// Register delegates & other onLoad stuff
// Because (run_at == document_idle), we may not catch window.onload event.
// https://developer.chrome.com/extensions/content_scripts#registration
// ===========================================================================

$('head').append($("<style>.markeddown ul>li {margin: 0 24px 8px;}</style>"));

setTimeout(function(){
    if (trelloBoardName) {

        // get the settings right away (may take a little bit if using Chrome cloud storage)
        refreshSettings();

        content = $('#content');
        content.delegate('.js-toggle-label-filter, .js-select-member, .js-due-filter, .js-clear-all', 'mouseup', calcListPoints);
        content.delegate('.js-input', 'keyup', calcListPoints);
        content.delegate('.js-share', 'mouseup', function(){
            setTimeout(checkExport, 500)
        });

        //watch filtering
        function updateFilters() {
            setTimeout(calcListPoints);
        };

        calcListPoints();
    }
    fixDirections();
}, 500);
