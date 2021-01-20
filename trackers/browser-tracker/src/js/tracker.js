/*
 * JavaScript tracker for Snowplow: tracker.js
 *
 * Significant portions copyright 2010 Anthon Pang. Remainder copyright
 * 2012-2020 Snowplow Analytics Ltd. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 * * Redistributions of source code must retain the above copyright
 *   notice, this list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright
 *   notice, this list of conditions and the following disclaimer in the
 *   documentation and/or other materials provided with the distribution.
 *
 * * Neither the name of Anthon Pang nor Snowplow Analytics Ltd nor the
 *   names of their contributors may be used to endorse or promote products
 *   derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import forEach from 'lodash/forEach';
import isInteger from 'lodash/isInteger';
import {
  getReferrer,
  fixupDomain,
  warn,
  findRootDomain,
  decorateQuerystring,
  addEventListener,
  getHostName,
  attemptGetLocalStorage,
  attemptWriteLocalStorage,
  attemptDeleteLocalStorage,
  fixupTitle,
  fromQuerystring,
  parseAndValidateFloat,
  parseAndValidateInt,
  cookie,
  deleteCookie,
  fixupUrl,
  detectViewport,
  detectDocumentSize,
} from '@snowplow/browser-core';
import sha1 from 'sha1';
import uuid from 'uuid/v4';
import { OutQueueManager } from './out_queue';
import { productionize } from './guard';
import { trackerCore } from '@snowplow/tracker-core';

/**
 * Snowplow Tracker class
 *
 * @param functionName global function name
 * @param namespace The namespace of the tracker object
 * @param version The current version of the JavaScript Tracker
 * @param mutSnowplowState An object containing hasLoaded, registeredOnLoadHandlers, and expireDateTime
 * 	      Passed in by reference in case they are altered by snowplow.js
 * @param argmap Optional dictionary of configuration options. Supported fields and their default values:
 *
 * 1. encodeBase64, true
 * 2. cookieDomain, null
 * 3. cookieName, '_sp_'
 * 4. appId, ''
 * 5. platform, 'web'
 * 6. respectDoNotTrack, false
 * 8. pageUnloadTimer, 500
 * 9. forceSecureTracker, false
 * 10. forceUnsecureTracker, false
 * 11. sessionCookieTimeout, 1800
 * 12. contexts, {}
 * 13. eventMethod, 'post'
 * 14. postPath, null
 * 15. useStm, true
 * 16. bufferSize, 1
 * 17. crossDomainLinker, false
 * 18. maxPostBytes, 40000
 * 19. discoverRootDomain, false
 * 20. cookieLifetime, 63072000
 * 21. stateStorageStrategy, 'cookieAndLocalStorage'
 * 22. maxLocalStorageQueueSize, 1000
 * 23. resetActivityTrackingOnPageView, true
 * 24. connectionTimeout, 5000
 * 26. anonymousTracking, false // bool | { withSessionTracking: bool, withServerAnonymisation: bool }
 */
export function Tracker(functionName, namespace, version, mutSnowplowState, argmap) {
  /************************************************************
   * Private members
   ************************************************************/

  var argmap = argmap || {};

  //use POST if eventMethod isn't present on the argmap
  argmap.eventMethod = argmap.eventMethod || 'post';

  // attach stm to GET requests by default
  if (!argmap.hasOwnProperty('useStm')) {
    argmap.useStm = true;
  }

  const getStateStorageStrategy = (config) =>
    config.hasOwnProperty('stateStorageStrategy') ? config.stateStorageStrategy : 'cookieAndLocalStorage';

  const getAnonymousSessionTracking = (config) =>
    config.hasOwnProperty('anonymousTracking') ? config.anonymousTracking.withSessionTracking === true : false;

  const getAnonymousServerTracking = (config) =>
    config.hasOwnProperty('anonymousTracking') ? config.anonymousTracking.withServerAnonymisation === true : false;

  const getAnonymousTracking = (config) => !!config.anonymousTracking;

  const contextPlugins = (argmap.contextPlugins || []).concat(getWebPagePlugin());

  var // Tracker core
    core = trackerCore(
      true,
      function (payload) {
        addBrowserData(payload);
        sendRequest(payload, configTrackerPause);
      },
      contextPlugins
    ),
    // Debug - whether to raise errors to console and log to console
    // or silence all errors from public methods
    debug = false,
    // API functions of the tracker
    apiMethods = {},
    // Safe methods (i.e. ones that won't raise errors)
    // These values should be guarded publicMethods
    safeMethods = {},
    // The client-facing methods returned from tracker IIFE
    returnMethods = {},
    // Aliases
    documentAlias = document,
    windowAlias = window,
    navigatorAlias = navigator,
    // Current URL and Referrer URL
    locationArray = fixupUrl(documentAlias.domain, windowAlias.location.href, getReferrer()),
    domainAlias = fixupDomain(locationArray[0]),
    locationHrefAlias = locationArray[1],
    configReferrerUrl = locationArray[2],
    customReferrer,
    // Platform defaults to web for this tracker
    configPlatform = argmap.hasOwnProperty('platform') ? argmap.platform : 'web',
    // Snowplow collector URL
    configCollectorUrl,
    // Custom path for post requests (to get around adblockers)
    configPostPath = argmap.hasOwnProperty('postPath') ? argmap.postPath : '/com.snowplowanalytics.snowplow/tp2',
    // Site ID
    configTrackerSiteId = argmap.hasOwnProperty('appId') ? argmap.appId : '', // Updated for Snowplow
    // Document URL
    configCustomUrl,
    // Document title
    lastDocumentTitle = documentAlias.title,
    // Custom title
    lastConfigTitle,
    // Maximum delay to wait for web bug image to be fetched (in milliseconds)
    configTrackerPause = argmap.hasOwnProperty('pageUnloadTimer') ? argmap.pageUnloadTimer : 500,
    // Controls whether activity tracking page ping event timers are reset on page view events
    resetActivityTrackingOnPageView = argmap.hasOwnProperty('resetActivityTrackingOnPageView')
      ? argmap.resetActivityTrackingOnPageView
      : true,
    // Disallow hash tags in URL. TODO: Should this be set to true by default?
    configDiscardHashTag,
    // Disallow brace in URL.
    configDiscardBrace,
    // First-party cookie name prefix
    configCookieNamePrefix = argmap.hasOwnProperty('cookieName') ? argmap.cookieName : '_sp_',
    // First-party cookie domain
    // User agent defaults to origin hostname
    configCookieDomain = argmap.hasOwnProperty('cookieDomain') ? argmap.cookieDomain : null,
    // First-party cookie path
    // Default is user agent defined.
    configCookiePath = '/',
    // First-party cookie samesite attribute
    configCookieSameSite = argmap.hasOwnProperty('cookieSameSite') ? argmap.cookieSameSite : 'None',
    // First-party cookie secure attribute
    configCookieSecure = argmap.hasOwnProperty('cookieSecure') ? argmap.cookieSecure : true,
    // Do Not Track browser feature
    dnt = navigatorAlias.doNotTrack || navigatorAlias.msDoNotTrack || windowAlias.doNotTrack,
    // Do Not Track
    configDoNotTrack = argmap.hasOwnProperty('respectDoNotTrack')
      ? argmap.respectDoNotTrack && (dnt === 'yes' || dnt === '1')
      : false,
    // Opt out of cookie tracking
    configOptOutCookie,
    // Life of the visitor cookie (in seconds)
    configVisitorCookieTimeout = argmap.hasOwnProperty('cookieLifetime') ? argmap.cookieLifetime : 63072000, // 2 years
    // Life of the session cookie (in seconds)
    configSessionCookieTimeout = argmap.hasOwnProperty('sessionCookieTimeout') ? argmap.sessionCookieTimeout : 1800, // 30 minutes
    // This forces the tracker to be HTTPS even if the page is not secure
    forceSecureTracker = argmap.hasOwnProperty('forceSecureTracker') ? argmap.forceSecureTracker === true : false,
    // This forces the tracker to be HTTP even if the page is secure
    forceUnsecureTracker =
      !forceSecureTracker && argmap.hasOwnProperty('forceUnsecureTracker')
        ? argmap.forceUnsecureTracker === true
        : false,
    // Allows tracking user session (using cookies or local storage), can only be used with anonymousTracking
    configAnonymousSessionTracking = getAnonymousSessionTracking(argmap),
    // Will send a header to server to prevent returning cookie and capturing IP
    configAnonymousServerTracking = getAnonymousServerTracking(argmap),
    // Sets tracker to work in anonymous mode without accessing client storage
    configAnonymousTracking = getAnonymousTracking(argmap),
    // Strategy defining how to store the state: cookie, localStorage, cookieAndLocalStorage or none
    configStateStorageStrategy = getStateStorageStrategy(argmap),
    // Unique ID for the tracker instance used to mark links which are being tracked
    trackerId = functionName + '_' + namespace,
    // Last activity timestamp
    lastActivityTime,
    // The last time an event was fired on the page - used to invalidate session if cookies are disabled
    lastEventTime = new Date().getTime(),
    // How are we scrolling?
    minXOffset,
    maxXOffset,
    minYOffset,
    maxYOffset,
    // Hash function
    hash = sha1,
    // Domain hash value
    domainHash,
    // Domain unique user ID
    domainUserId,
    // ID for the current session
    memorizedSessionId,
    // Index for the current session - kept in memory in case cookies are disabled
    memorizedVisitCount = 1,
    // Business-defined unique user ID
    businessUserId,
    // Ecommerce transaction data
    // Will be committed, sent and emptied by a call to trackTrans.
    ecommerceTransaction = ecommerceTransactionTemplate(),
    // Manager for local storage queue
    outQueue = new OutQueueManager(
      functionName,
      namespace,
      mutSnowplowState,
      configStateStorageStrategy == 'localStorage' || configStateStorageStrategy == 'cookieAndLocalStorage',
      argmap.eventMethod,
      configPostPath,
      argmap.bufferSize,
      argmap.maxPostBytes || 40000,
      argmap.useStm,
      argmap.maxLocalStorageQueueSize || 1000,
      argmap.connectionTimeout || 5000,
      configAnonymousServerTracking
    ),
    // Enhanced Ecommerce Contexts to be added on every `trackEnhancedEcommerceAction` call
    enhancedEcommerceContexts = [],
    // Whether pageViewId should be regenerated after each trackPageView. Affect web_page context
    preservePageViewId = false,
    // Whether first trackPageView was fired and pageViewId should not be changed anymore until reload
    pageViewSent = false,
    // Activity tracking config for callback and pacge ping variants
    activityTrackingConfig = {
      enabled: false,
      installed: false, // Guard against installing the activity tracker more than once per Tracker instance
      configurations: {},
    },
    apiPlugins = argmap.apiPlugins || [],
    detectors = argmap.detectors || {};

  if (argmap.hasOwnProperty('discoverRootDomain') && argmap.discoverRootDomain) {
    configCookieDomain = findRootDomain(configCookieSameSite, configCookieSecure);
  }

  // Enable base 64 encoding for self-describing events and custom contexts
  core.setBase64Encoding(argmap.hasOwnProperty('encodeBase64') ? argmap.encodeBase64 : true);

  // Set up unchanging name-value pairs
  core.setTrackerVersion(version);
  core.setTrackerNamespace(namespace);
  core.setAppId(configTrackerSiteId);
  core.setPlatform(configPlatform);

  if (detectors.timezone) detectors.timezone(core);
  if (detectors.browserFeatures) detectors.browserFeatures(core);
  if (detectors.screen) detectors.screen(core);
  if (detectors.document) detectors.document(core);
  if (detectors.cookie) detectors.cookie(core);
  
  /**
   * Recalculate the domain, URL, and referrer
   */
  function refreshUrl() {
    locationArray = fixupUrl(documentAlias.domain, windowAlias.location.href, getReferrer());

    // If this is a single-page app and the page URL has changed, then:
    //   - if the new URL's querystring contains a "refer(r)er" parameter, use it as the referrer
    //   - otherwise use the old URL as the referer
    if (locationArray[1] !== locationHrefAlias) {
      configReferrerUrl = getReferrer(locationHrefAlias);
    }

    domainAlias = fixupDomain(locationArray[0]);
    locationHrefAlias = locationArray[1];
  }

  /**
   * Decorate the querystring of a single link
   *
   * @param event e The event targeting the link
   */
  function linkDecorationHandler() {
    var tstamp = new Date().getTime();
    if (this.href) {
      this.href = decorateQuerystring(this.href, '_sp', domainUserId + '.' + tstamp);
    }
  }

  /**
   * Enable querystring decoration for links pasing a filter
   * Whenever such a link is clicked on or navigated to via the keyboard,
   * add "_sp={{duid}}.{{timestamp}}" to its querystring
   *
   * @param crossDomainLinker Function used to determine which links to decorate
   */
  function decorateLinks(crossDomainLinker) {
    for (var i = 0; i < documentAlias.links.length; i++) {
      var elt = documentAlias.links[i];
      if (!elt.spDecorationEnabled && crossDomainLinker(elt)) {
        addEventListener(elt, 'click', linkDecorationHandler, true);
        addEventListener(elt, 'mousedown', linkDecorationHandler, true);

        // Don't add event listeners more than once
        elt.spDecorationEnabled = true;
      }
    }
  }

  /*
   * Initializes an empty ecommerce
   * transaction and line items
   */
  function ecommerceTransactionTemplate() {
    return {
      transaction: {},
      items: [],
    };
  }

  /*
   * Removes hash tag from the URL
   *
   * URLs are purified before being recorded in the cookie,
   * or before being sent as GET parameters
   */
  function purify(url) {
    var targetPattern;

    if (configDiscardHashTag) {
      targetPattern = new RegExp('#.*');
      url = url.replace(targetPattern, '');
    }

    if (configDiscardBrace) {
      targetPattern = new RegExp('[{}]', 'g');
      url = url.replace(targetPattern, '');
    }
    return url;
  }

  /*
   * Extract scheme/protocol from URL
   */
  function getProtocolScheme(url) {
    var e = new RegExp('^([a-z]+):'),
      matches = e.exec(url);

    return matches ? matches[1] : null;
  }

  /*
   * Resolve relative reference
   *
   * Note: not as described in rfc3986 section 5.2
   */
  function resolveRelativeReference(baseUrl, url) {
    var protocol = getProtocolScheme(url),
      i;

    if (protocol) {
      return url;
    }

    if (url.slice(0, 1) === '/') {
      return getProtocolScheme(baseUrl) + '://' + getHostName(baseUrl) + url;
    }

    baseUrl = purify(baseUrl);
    if ((i = baseUrl.indexOf('?')) >= 0) {
      baseUrl = baseUrl.slice(0, i);
    }
    if ((i = baseUrl.lastIndexOf('/')) !== baseUrl.length - 1) {
      baseUrl = baseUrl.slice(0, i + 1);
    }

    return baseUrl + url;
  }

  /*
   * Send request
   */
  function sendRequest(request, delay) {
    var now = new Date();

    // Set to true if Opt-out cookie is defined
    var toOptoutByCookie;
    if (configOptOutCookie) {
      toOptoutByCookie = !!cookie(configOptOutCookie);
    } else {
      toOptoutByCookie = false;
    }

    if (!(configDoNotTrack || toOptoutByCookie)) {
      outQueue.enqueueRequest(request.build(), configCollectorUrl);
      mutSnowplowState.expireDateTime = now.getTime() + delay;
    }
  }

  /*
   * Get cookie name with prefix and domain hash
   */
  function getSnowplowCookieName(baseName) {
    return configCookieNamePrefix + baseName + '.' + domainHash;
  }

  /*
   * Cookie getter.
   */
  function getSnowplowCookieValue(cookieName) {
    var fullName = getSnowplowCookieName(cookieName);
    if (configStateStorageStrategy == 'localStorage') {
      return attemptGetLocalStorage(fullName);
    } else if (configStateStorageStrategy == 'cookie' || configStateStorageStrategy == 'cookieAndLocalStorage') {
      return cookie(fullName);
    }
  }

  /*
   * Update domain hash
   */
  function updateDomainHash() {
    refreshUrl();
    domainHash = hash((configCookieDomain || domainAlias) + (configCookiePath || '/')).slice(0, 4); // 4 hexits = 16 bits
  }

  /*
   * Process all "activity" events.
   * For performance, this function must have low overhead.
   */
  function activityHandler() {
    var now = new Date();
    lastActivityTime = now.getTime();
  }

  /*
   * Process all "scroll" events.
   */
  function scrollHandler() {
    updateMaxScrolls();
    activityHandler();
  }

  /*
   * Returns [pageXOffset, pageYOffset].
   * Adapts code taken from: http://www.javascriptkit.com/javatutors/static2.shtml
   */
  function getPageOffsets() {
    var iebody =
      documentAlias.compatMode && documentAlias.compatMode !== 'BackCompat'
        ? documentAlias.documentElement
        : documentAlias.body;
    return [iebody.scrollLeft || windowAlias.pageXOffset, iebody.scrollTop || windowAlias.pageYOffset];
  }

  /*
   * Quick initialization/reset of max scroll levels
   */
  function resetMaxScrolls() {
    var offsets = getPageOffsets();

    var x = offsets[0];
    minXOffset = x;
    maxXOffset = x;

    var y = offsets[1];
    minYOffset = y;
    maxYOffset = y;
  }

  /*
   * Check the max scroll levels, updating as necessary
   */
  function updateMaxScrolls() {
    var offsets = getPageOffsets();

    var x = offsets[0];
    if (x < minXOffset) {
      minXOffset = x;
    } else if (x > maxXOffset) {
      maxXOffset = x;
    }

    var y = offsets[1];
    if (y < minYOffset) {
      minYOffset = y;
    } else if (y > maxYOffset) {
      maxYOffset = y;
    }
  }

  /*
   * Prevents offsets from being decimal or NaN
   * See https://github.com/snowplow/snowplow-javascript-tracker/issues/324
   * TODO: the NaN check should be moved into the core
   */
  function cleanOffset(offset) {
    var rounded = Math.round(offset);
    if (!isNaN(rounded)) {
      return rounded;
    }
  }

  /*
   * Sets or renews the session cookie
   */
  function setSessionCookie() {
    var cookieName = getSnowplowCookieName('ses');
    var cookieValue = '*';
    setCookie(cookieName, cookieValue, configSessionCookieTimeout);
  }

  /*
   * Sets the Visitor ID cookie: either the first time loadDomainUserIdCookie is called
   * or when there is a new visit or a new page view
   */
  function setDomainUserIdCookie(_domainUserId, createTs, visitCount, nowTs, lastVisitTs, sessionId) {
    var cookieName = getSnowplowCookieName('id');
    var cookieValue =
      _domainUserId + '.' + createTs + '.' + visitCount + '.' + nowTs + '.' + lastVisitTs + '.' + sessionId;
    setCookie(cookieName, cookieValue, configVisitorCookieTimeout);
  }

  /*
   * no-op if anonymousTracking enabled, will still set cookies if anonymousSessionTracking is enabled
   * Sets a cookie based on the storage strategy:
   * - if 'localStorage': attemps to write to local storage
   * - if 'cookie' or 'cookieAndLocalStorage': writes to cookies
   * - otherwise: no-op
   */
  function setCookie(name, value, timeout) {
    if (configAnonymousTracking && !configAnonymousSessionTracking) {
      return;
    }

    if (configStateStorageStrategy == 'localStorage') {
      attemptWriteLocalStorage(name, value, timeout);
    } else if (configStateStorageStrategy == 'cookie' || configStateStorageStrategy == 'cookieAndLocalStorage') {
      cookie(name, value, timeout, configCookiePath, configCookieDomain, configCookieSameSite, configCookieSecure);
    }
  }

  /**
   * Generate a pseudo-unique ID to identify this user
   */
  function createNewDomainUserId() {
    return uuid();
  }

  /**
   * Clears all cookie and local storage for id and ses values
   */
  function deleteCookies() {
    const idname = getSnowplowCookieName('id');
    const sesname = getSnowplowCookieName('ses');
    attemptDeleteLocalStorage(idname);
    attemptDeleteLocalStorage(sesname);
    deleteCookie(idname, configCookieDomain, configCookieSameSite, configCookieSecure);
    deleteCookie(sesname, configCookieDomain, configCookieSameSite, configCookieSecure);
  }

  /*
   * Load the domain user ID and the session ID
   * Set the cookies (if cookies are enabled)
   */
  function initializeIdsAndCookies() {
    if (configAnonymousTracking && !configAnonymousSessionTracking) {
      return;
    }

    var sesCookieSet = configStateStorageStrategy != 'none' && !!getSnowplowCookieValue('ses');
    var idCookieComponents = loadDomainUserIdCookie();

    if (idCookieComponents[1]) {
      domainUserId = idCookieComponents[1];
    } else if (!configAnonymousTracking) {
      domainUserId = createNewDomainUserId();
      idCookieComponents[1] = domainUserId;
    } else {
      domainUserId = '';
      idCookieComponents[1] = domainUserId;
    }

    memorizedSessionId = idCookieComponents[6];

    if (!sesCookieSet) {
      // Increment the session ID
      idCookieComponents[3]++;
      // Create a new sessionId
      memorizedSessionId = uuid();
      idCookieComponents[6] = memorizedSessionId;
      // Set lastVisitTs to currentVisitTs
      idCookieComponents[5] = idCookieComponents[4];
    }

    if (configStateStorageStrategy != 'none') {
      setSessionCookie();
      // Update currentVisitTs
      idCookieComponents[4] = Math.round(new Date().getTime() / 1000);
      idCookieComponents.shift();
      setDomainUserIdCookie.apply(null, idCookieComponents);
    }
  }

  /*
   * Load visitor ID cookie
   */
  function loadDomainUserIdCookie() {
    if (configStateStorageStrategy == 'none') {
      return [];
    }
    var now = new Date(),
      nowTs = Math.round(now.getTime() / 1000),
      id = getSnowplowCookieValue('id'),
      tmpContainer;

    if (id) {
      tmpContainer = id.split('.');
      // cookies enabled
      tmpContainer.unshift('0');
    } else {
      tmpContainer = [
        // cookies disabled
        '1',
        // Domain user ID
        domainUserId,
        // Creation timestamp - seconds since Unix epoch
        nowTs,
        // visitCount - 0 = no previous visit
        0,
        // Current visit timestamp
        nowTs,
        // Last visit timestamp - blank meaning no previous visit
        '',
      ];
    }

    if (!tmpContainer[6]) {
      // session id
      tmpContainer[6] = uuid();
    }

    return tmpContainer;
  }

  /*
   * Attaches common web fields to every request
   * (resolution, url, referrer, etc.)
   * Also sets the required cookies.
   */
  function addBrowserData(sb) {
    const anonymizeOr = (value) => (configAnonymousTracking ? null : value);
    const anonymizeSessionOr = (value) => (configAnonymousSessionTracking ? value : anonymizeOr(value));

    var nowTs = Math.round(new Date().getTime() / 1000),
      ses = getSnowplowCookieValue('ses'),
      id = loadDomainUserIdCookie(),
      cookiesDisabled = id[0],
      _domainUserId = id[1], // We could use the global (domainUserId) but this is better etiquette
      createTs = id[2],
      visitCount = id[3],
      currentVisitTs = id[4],
      lastVisitTs = id[5],
      sessionIdFromCookie = id[6];

    var toOptoutByCookie;
    if (configOptOutCookie) {
      toOptoutByCookie = !!cookie(configOptOutCookie);
    } else {
      toOptoutByCookie = false;
    }

    if (configDoNotTrack || toOptoutByCookie) {
      deleteCookies();
      return;
    }

    // If cookies are enabled, base visit count and session ID on the cookies
    if (cookiesDisabled === '0') {
      memorizedSessionId = sessionIdFromCookie;

      // New session?
      if (!ses && configStateStorageStrategy != 'none') {
        // New session (aka new visit)
        visitCount++;
        // Update the last visit timestamp
        lastVisitTs = currentVisitTs;
        // Regenerate the session ID
        memorizedSessionId = uuid();
      }

      memorizedVisitCount = visitCount;
    } else if (new Date().getTime() - lastEventTime > configSessionCookieTimeout * 1000) {
      memorizedSessionId = uuid();
      memorizedVisitCount++;
    }

    // Build out the rest of the request
    if (detectors.window) detectors.window(sb);
    sb.add('vid', anonymizeSessionOr(memorizedVisitCount));
    sb.add('sid', anonymizeSessionOr(memorizedSessionId));
    sb.add('duid', anonymizeOr(_domainUserId)); // Set to our local variable
    sb.add('uid', anonymizeOr(businessUserId));

    refreshUrl();

    sb.add('refr', purify(customReferrer || configReferrerUrl));

    // Add the page URL last as it may take us over the IE limit (and we don't always need it)
    sb.add('url', purify(configCustomUrl || locationHrefAlias));

    // Update cookies
    if (configStateStorageStrategy != 'none') {
      setDomainUserIdCookie(_domainUserId, createTs, memorizedVisitCount, nowTs, lastVisitTs, memorizedSessionId);
      setSessionCookie();
    }

    lastEventTime = new Date().getTime();
  }

  /**
   * Adds the protocol in front of our collector URL, and i to the end
   *
   * @param string rawUrl The collector URL without protocol
   *
   * @return string collectorUrl The tracker URL with protocol
   */
  function asCollectorUrl(rawUrl) {
    if (forceSecureTracker) {
      return 'https' + '://' + rawUrl;
    }
    if (forceUnsecureTracker) {
      return 'http' + '://' + rawUrl;
    }
    return ('https:' === documentAlias.location.protocol ? 'https' : 'http') + '://' + rawUrl;
  }

  /**
   * Initialize new `pageViewId` if it shouldn't be preserved.
   * Should be called when `trackPageView` is invoked
   */
  function resetPageView() {
    if (!preservePageViewId || mutSnowplowState.pageViewId == null) {
      mutSnowplowState.pageViewId = uuid();
    }
  }

  /**
   * Safe function to get `pageViewId`.
   * Generates it if it wasn't initialized by other tracker
   */
  function getPageViewId() {
    if (mutSnowplowState.pageViewId == null) {
      mutSnowplowState.pageViewId = uuid();
    }
    return mutSnowplowState.pageViewId;
  }

  /**
   * Put together a web page context with a unique UUID for the page view
   *
   * @return object web_page context
   */
  function getWebPagePlugin() {
    return {
      getContexts: () => {
        return [
          {
            schema: 'iglu:com.snowplowanalytics.snowplow/web_page/jsonschema/1-0-0',
            data: {
              id: getPageViewId(),
            },
          },
        ];
      },
    };
  }

  /**
   * Expires current session and starts a new session.
   */
  function newSession() {
    // If cookies are enabled, base visit count and session ID on the cookies
    var nowTs = Math.round(new Date().getTime() / 1000),
      id = loadDomainUserIdCookie(),
      cookiesDisabled = id[0],
      _domainUserId = id[1], // We could use the global (domainUserId) but this is better etiquette
      createTs = id[2],
      visitCount = id[3],
      currentVisitTs = id[4],
      lastVisitTs = id[5],
      sessionIdFromCookie = id[6];

    // When cookies are enabled
    if (cookiesDisabled === '0') {
      memorizedSessionId = sessionIdFromCookie;

      // When cookie/local storage is enabled - make a new session
      if (configStateStorageStrategy != 'none') {
        // New session (aka new visit)
        visitCount++;
        // Update the last visit timestamp
        lastVisitTs = currentVisitTs;
        // Regenerate the session ID
        memorizedSessionId = uuid();
      }

      memorizedVisitCount = visitCount;

      // Create a new session cookie
      setSessionCookie();
    } else {
      memorizedSessionId = uuid();
      memorizedVisitCount++;
    }

    // Update cookies
    if (configStateStorageStrategy != 'none') {
      setDomainUserIdCookie(_domainUserId, createTs, memorizedVisitCount, nowTs, lastVisitTs, memorizedSessionId);
      setSessionCookie();
    }

    lastEventTime = new Date().getTime();
  }

  /**
   * Combine an array of unchanging contexts with the result of a context-creating function
   *
   * @param staticContexts Array of custom contexts
   * @param contextCallback Function returning an array of contexts
   */
  function finalizeContexts(staticContexts, contextCallback) {
    return (staticContexts || []).concat(contextCallback ? contextCallback() : []);
  }

  /**
   * Log the page view / visit
   *
   * @param customTitle string The user-defined page title to attach to this page view
   * @param context object Custom context relating to the event
   * @param contextCallback Function returning an array of contexts
   * @param tstamp number
   * @param function afterTrack (optional) A callback function triggered after event is tracked
   */
  function logPageView(customTitle, context, contextCallback, tstamp, afterTrack) {
    refreshUrl();
    if (pageViewSent) {
      // Do not reset pageViewId if previous events were not page_view
      resetPageView();
    }
    pageViewSent = true;

    // So we know what document.title was at the time of trackPageView
    lastDocumentTitle = documentAlias.title;
    lastConfigTitle = customTitle;

    // Fixup page title
    var pageTitle = fixupTitle(lastConfigTitle || lastDocumentTitle);

    // Log page view
    core.trackPageView(
      purify(configCustomUrl || locationHrefAlias),
      pageTitle,
      purify(customReferrer || configReferrerUrl),
      finalizeContexts(context, contextCallback),
      tstamp,
      afterTrack
    );

    // Send ping (to log that user has stayed on page)
    var now = new Date();
    var installingActivityTracking = false;

    if (activityTrackingConfig.enabled && !activityTrackingConfig.installed) {
      activityTrackingConfig.installed = true;
      installingActivityTracking = true;

      // Add mousewheel event handler, detect passive event listeners for performance
      var detectPassiveEvents = {
        update: function update() {
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            var passive = false;
            var options = Object.defineProperty({}, 'passive', {
              get: function get() {
                passive = true;
              },
            });
            // note: have to set and remove a no-op listener instead of null
            // (which was used previously), becasue Edge v15 throws an error
            // when providing a null callback.
            // https://github.com/rafrex/detect-passive-events/pull/3
            var noop = function noop() {};
            window.addEventListener('testPassiveEventSupport', noop, options);
            window.removeEventListener('testPassiveEventSupport', noop, options);
            detectPassiveEvents.hasSupport = passive;
          }
        },
      };
      detectPassiveEvents.update();

      // Detect available wheel event
      var wheelEvent =
        'onwheel' in document.createElement('div')
          ? 'wheel' // Modern browsers support "wheel"
          : document.onmousewheel !== undefined
          ? 'mousewheel' // Webkit and IE support at least "mousewheel"
          : 'DOMMouseScroll'; // let's assume that remaining browsers are older Firefox

      if (Object.prototype.hasOwnProperty.call(detectPassiveEvents, 'hasSupport')) {
        addEventListener(documentAlias, wheelEvent, activityHandler, { passive: true });
      } else {
        addEventListener(documentAlias, wheelEvent, activityHandler);
      }

      // Capture our initial scroll points
      resetMaxScrolls();

      // Add event handlers; cross-browser compatibility here varies significantly
      // @see http://quirksmode.org/dom/events
      const documentHandlers = ['click', 'mouseup', 'mousedown', 'mousemove', 'keypress', 'keydown', 'keyup'];
      const windowHandlers = ['resize', 'focus', 'blur'];
      const listener = (alias, handler = activityHandler) => (ev) => addEventListener(documentAlias, ev, handler);

      forEach(documentHandlers, listener(documentAlias));
      forEach(windowHandlers, listener(windowAlias));
      listener(windowAlias, scrollHandler)('scroll');
    }

    if (activityTrackingConfig.enabled && (resetActivityTrackingOnPageView || installingActivityTracking)) {
      // Periodic check for activity.
      lastActivityTime = now.getTime();

      for (var key in activityTrackingConfig.configurations) {
        if (activityTrackingConfig.configurations.hasOwnProperty(key)) {
          const config = activityTrackingConfig.configurations[key];

          //Clear page ping heartbeat on new page view
          clearInterval(config.activityInterval);

          activityInterval(config, context, contextCallback);
        }
      }
    }
  }

  function activityInterval(config, context, contextCallback) {
    const executePagePing = (cb, c) => {
      refreshUrl();
      cb({ context: c, pageViewId: getPageViewId(), minXOffset, minYOffset, maxXOffset, maxYOffset });
      resetMaxScrolls();
    };

    const timeout = () => {
      var now = new Date();

      // There was activity during the heart beat period;
      // on average, this is going to overstate the visitDuration by configHeartBeatTimer/2
      if (lastActivityTime + config.configMinimumVisitLength > now.getTime()) {
        executePagePing(config.callback, finalizeContexts(context, contextCallback));
      }

      config.activityInterval = setInterval(heartbeat, config.configHeartBeatTimer);
    };

    const heartbeat = () => {
      var now = new Date();

      // There was activity during the heart beat period;
      // on average, this is going to overstate the visitDuration by configHeartBeatTimer/2
      if (lastActivityTime + config.configHeartBeatTimer > now.getTime()) {
        executePagePing(config.callback, finalizeContexts(context, contextCallback));
      }
    };

    if (config.configMinimumVisitLength != 0) {
      config.activityInterval = setTimeout(timeout, config.configMinimumVisitLength);
    } else {
      config.activityInterval = setInterval(heartbeat, config.configHeartBeatTimer);
    }
  }

  /**
   * Configure the activity tracking and
   * ensures good values for min visit and heartbeat
   *
   * @param {int} [minimumVisitLength] The minimum length of a visit before the first page ping
   * @param {int} [heartBeatDelay] The length between checks to see if we should send a page ping
   * @param {function} [callback] A callback function to execute
   */
  function configureActivityTracking(minimumVisitLength, heartBeatDelay, callback) {
    if (isInteger(minimumVisitLength) && isInteger(heartBeatDelay)) {
      return {
        configMinimumVisitLength: minimumVisitLength * 1000,
        configHeartBeatTimer: heartBeatDelay * 1000,
        activityInterval: null,
        callback,
      };
    }

    warn('Activity tracking not enabled, please provide integer values for minimumVisitLength and heartBeatDelay.');
    return {};
  }

  /**
   * Log that a user is still viewing a given page
   * by sending a page ping.
   * Not part of the public API - only called from
   * logPageView() above.
   *
   * @param context object Custom context relating to the event
   */
  function logPagePing({ context, minXOffset, minYOffset, maxXOffset, maxYOffset }) {
    var newDocumentTitle = documentAlias.title;
    if (newDocumentTitle !== lastDocumentTitle) {
      lastDocumentTitle = newDocumentTitle;
      lastConfigTitle = null;
    }
    core.trackPagePing(
      purify(configCustomUrl || locationHrefAlias),
      fixupTitle(lastConfigTitle || lastDocumentTitle),
      purify(customReferrer || configReferrerUrl),
      cleanOffset(minXOffset),
      cleanOffset(maxXOffset),
      cleanOffset(minYOffset),
      cleanOffset(maxYOffset),
      context
    );
  }

  /**
   * Log ecommerce transaction metadata
   *
   * @param string orderId
   * @param string affiliation
   * @param string total
   * @param string tax
   * @param string shipping
   * @param string city
   * @param string state
   * @param string country
   * @param string currency The currency the total/tax/shipping are expressed in
   * @param object context Custom context relating to the event
   * @param tstamp number or Timestamp object
   */
  function logTransaction(orderId, affiliation, total, tax, shipping, city, state, country, currency, context, tstamp) {
    core.trackEcommerceTransaction(
      orderId,
      affiliation,
      total,
      tax,
      shipping,
      city,
      state,
      country,
      currency,
      context,
      tstamp
    );
  }

  /**
   * Log ecommerce transaction item
   *
   * @param string orderId
   * @param string sku
   * @param string name
   * @param string category
   * @param string price
   * @param string quantity
   * @param string currency The currency the price is expressed in
   * @param object context Custom context relating to the event
   */
  function logTransactionItem(orderId, sku, name, category, price, quantity, currency, context, tstamp) {
    core.trackEcommerceTransactionItem(orderId, sku, name, category, price, quantity, currency, context, tstamp);
  }

  /**
   * Update the returned methods (public facing methods)
   */
  function updateReturnMethods() {
    if (debug) {
      returnMethods = apiMethods;
    } else {
      returnMethods = safeMethods;
    }
  }

  /************************************************************
   * Constructor
   ************************************************************/

  /*
   * Initialize tracker
   */
  updateDomainHash();

  initializeIdsAndCookies();

  if (argmap.crossDomainLinker) {
    decorateLinks(argmap.crossDomainLinker);
  }

  /************************************************************
   * Public data and methods
   ************************************************************/

  /**
   * Get the domain session index also known as current memorized visit count.
   *
   * @return int Domain session index
   */
  apiMethods.getDomainSessionIndex = function () {
    return memorizedVisitCount;
  };

  /**
   * Get the page view ID as generated or provided by mutSnowplowState.pageViewId.
   *
   * @return string Page view ID
   */
  apiMethods.getPageViewId = function () {
    return getPageViewId();
  };

  /**
   * Expires current session and starts a new session.
   */
  apiMethods.newSession = newSession;

  /**
   * Get the cookie name as cookieNamePrefix + basename + . + domain.
   *
   * @return string Cookie name
   */
  apiMethods.getCookieName = function (basename) {
    return getSnowplowCookieName(basename);
  };

  /**
   * Get the current user ID (as set previously
   * with setUserId()).
   *
   * @return string Business-defined user ID
   */
  apiMethods.getUserId = function () {
    return businessUserId;
  };

  /**
   * Get visitor ID (from first party cookie)
   *
   * @return string Visitor ID in hexits (or null, if not yet known)
   */
  apiMethods.getDomainUserId = function () {
    return loadDomainUserIdCookie()[1];
  };

  /**
   * Get the visitor information (from first party cookie)
   *
   * @return array
   */
  apiMethods.getDomainUserInfo = function () {
    return loadDomainUserIdCookie();
  };

  /**
   * Override referrer
   *
   * @param string url
   */
  apiMethods.setReferrerUrl = function (url) {
    customReferrer = url;
  };

  /**
   * Override url
   *
   * @param string url
   */
  apiMethods.setCustomUrl = function (url) {
    refreshUrl();
    configCustomUrl = resolveRelativeReference(locationHrefAlias, url);
  };

  /**
   * Override document.title
   *
   * @param string title
   */
  apiMethods.setDocumentTitle = function (title) {
    // So we know what document.title was at the time of trackPageView
    lastDocumentTitle = documentAlias.title;
    lastConfigTitle = title;
  };

  /**
   * Strip hash tag (or anchor) from URL
   *
   * @param bool enableFilter
   */
  apiMethods.discardHashTag = function (enableFilter) {
    configDiscardHashTag = enableFilter;
  };

  /**
   * Strip braces from URL
   *
   * @param bool enableFilter
   */
  apiMethods.discardBrace = function (enableFilter) {
    configDiscardBrace = enableFilter;
  };

  /**
   * Set first-party cookie path
   *
   * @param string domain
   */
  apiMethods.setCookiePath = function (path) {
    configCookiePath = path;
    updateDomainHash();
  };

  /**
   * Set visitor cookie timeout (in seconds)
   *
   * @param int timeout
   */
  apiMethods.setVisitorCookieTimeout = function (timeout) {
    configVisitorCookieTimeout = timeout;
  };

  /**
   * Enable querystring decoration for links pasing a filter
   *
   * @param function crossDomainLinker Function used to determine which links to decorate
   */
  apiMethods.crossDomainLinker = function (crossDomainLinkerCriterion) {
    decorateLinks(crossDomainLinkerCriterion);
  };

  /**
   * Enables page activity tracking (sends page
   * pings to the Collector regularly).
   *
   * @param int minimumVisitLength Seconds to wait before sending first page ping
   * @param int heartBeatDelay Seconds to wait between pings
   */
  apiMethods.enableActivityTracking = function (minimumVisitLength, heartBeatDelay) {
    activityTrackingConfig.enabled = true;
    activityTrackingConfig.configurations.pagePing = configureActivityTracking(
      minimumVisitLength,
      heartBeatDelay,
      logPagePing
    );
  };

  /**
   * Enables page activity tracking (replaces collector ping with callback).
   *
   * @param int minimumVisitLength Seconds to wait before sending first page ping
   * @param int heartBeatDelay Seconds to wait between pings
   * @param function callback function called with ping data
   */
  apiMethods.enableActivityTrackingCallback = function (minimumVisitLength, heartBeatDelay, callback) {
    activityTrackingConfig.enabled = true;
    activityTrackingConfig.configurations.callback = configureActivityTracking(
      minimumVisitLength,
      heartBeatDelay,
      callback
    );
  };

  /**
   * Triggers the activityHandler manually to allow external user defined
   * activity. i.e. While watching a video
   */
  apiMethods.updatePageActivity = function () {
    activityHandler();
  };

  /**
   * Sets the opt out cookie.
   *
   * @param string name of the opt out cookie
   */
  apiMethods.setOptOutCookie = function (name) {
    configOptOutCookie = name;
  };

  /**
   * Set the business-defined user ID for this user.
   *
   * @param string userId The business-defined user ID
   */
  apiMethods.setUserId = function (userId) {
    businessUserId = userId;
  };

  /**
   * Alias for setUserId.
   *
   * @param string userId The business-defined user ID
   */
  apiMethods.identifyUser = function (userId) {
    apiMethods.setUserId(userId);
  };

  /**
   * Set the business-defined user ID for this user using the location querystring.
   *
   * @param string queryName Name of a querystring name-value pair
   */
  apiMethods.setUserIdFromLocation = function (querystringField) {
    refreshUrl();
    businessUserId = fromQuerystring(querystringField, locationHrefAlias);
  };

  /**
   * Set the business-defined user ID for this user using the referrer querystring.
   *
   * @param string queryName Name of a querystring name-value pair
   */
  apiMethods.setUserIdFromReferrer = function (querystringField) {
    refreshUrl();
    businessUserId = fromQuerystring(querystringField, configReferrerUrl);
  };

  /**
   * Set the business-defined user ID for this user to the value of a cookie.
   *
   * @param string cookieName Name of the cookie whose value will be assigned to businessUserId
   */
  apiMethods.setUserIdFromCookie = function (cookieName) {
    businessUserId = cookie(cookieName);
  };

  /**
   *
   * Specify the Snowplow collector URL. No need to include HTTP
   * or HTTPS - we will add this.
   *
   * @param string rawUrl The collector URL minus protocol and /i
   */
  apiMethods.setCollectorUrl = function (rawUrl) {
    configCollectorUrl = asCollectorUrl(rawUrl);
    outQueue.setCollectorUrl(configCollectorUrl);
  };

  /**
   * Send all events in the outQueue
   * Use only when sending POSTs with a bufferSize of at least 2
   */
  apiMethods.flushBuffer = function () {
    outQueue.executeQueue();
  };

  /**
   * Log visit to this page
   *
   * @param string customTitle
   * @param object Custom context relating to the event
   * @param object contextCallback Function returning an array of contexts
   * @param tstamp number or Timestamp object
   * @param function afterTrack (optional) A callback function triggered after event is tracked
   */
  apiMethods.trackPageView = function (customTitle, context, contextCallback, tstamp, afterTrack) {
    logPageView(customTitle, context, contextCallback, tstamp, afterTrack);
  };

  /**
   * Track a structured event happening on this page.
   *
   * Replaces trackEvent, making clear that the type
   * of event being tracked is a structured one.
   *
   * @param string category The name you supply for the group of objects you want to track
   * @param string action A string that is uniquely paired with each category, and commonly used to define the type of user interaction for the web object
   * @param string label (optional) An optional string to provide additional dimensions to the event data
   * @param string property (optional) Describes the object or the action performed on it, e.g. quantity of item added to basket
   * @param int|float|string value (optional) An integer that you can use to provide numerical data about the user event
   * @param object context (optional) Custom context relating to the event
   * @param number|Timestamp tstamp (optional) TrackerTimestamp of the event
   * @param function afterTrack (optional) A callback function triggered after event is tracked
   */
  apiMethods.trackStructEvent = function (category, action, label, property, value, context, tstamp, afterTrack) {
    core.trackStructEvent(category, action, label, property, value, context, tstamp, afterTrack);
  };

  /**
   * Track a self-describing event happening on this page.
   *
   * @param object eventJson Contains the properties and schema location for the event
   * @param object context Custom context relating to the event
   * @param tstamp number or Timestamp object
   * @param function afterTrack (optional) A callback function triggered after event is tracked
   */
  apiMethods.trackSelfDescribingEvent = function (eventJson, context, tstamp, afterTrack) {
    core.trackSelfDescribingEvent(eventJson, context, tstamp, afterTrack);
  };

  /**
   * Track an ecommerce transaction
   *
   * @param string orderId Required. Internal unique order id number for this transaction.
   * @param string affiliation Optional. Partner or store affiliation.
   * @param string total Required. Total amount of the transaction.
   * @param string tax Optional. Tax amount of the transaction.
   * @param string shipping Optional. Shipping charge for the transaction.
   * @param string city Optional. City to associate with transaction.
   * @param string state Optional. State to associate with transaction.
   * @param string country Optional. Country to associate with transaction.
   * @param string currency Optional. Currency to associate with this transaction.
   * @param object context Optional. Context relating to the event.
   * @param tstamp number or Timestamp object
   */
  apiMethods.addTrans = function (
    orderId,
    affiliation,
    total,
    tax,
    shipping,
    city,
    state,
    country,
    currency,
    context,
    tstamp
  ) {
    ecommerceTransaction.transaction = {
      orderId: orderId,
      affiliation: affiliation,
      total: total,
      tax: tax,
      shipping: shipping,
      city: city,
      state: state,
      country: country,
      currency: currency,
      context: context,
      tstamp: tstamp,
    };
  };

  /**
   * Track an ecommerce transaction item
   *
   * @param string orderId Required Order ID of the transaction to associate with item.
   * @param string sku Required. Item's SKU code.
   * @param string name Optional. Product name.
   * @param string category Optional. Product category.
   * @param string price Required. Product price.
   * @param string quantity Required. Purchase quantity.
   * @param string currency Optional. Product price currency.
   * @param object context Optional. Context relating to the event.
   * @param tstamp number or Timestamp object
   */
  apiMethods.addItem = function (orderId, sku, name, category, price, quantity, currency, context, tstamp) {
    ecommerceTransaction.items.push({
      orderId: orderId,
      sku: sku,
      name: name,
      category: category,
      price: price,
      quantity: quantity,
      currency: currency,
      context: context,
      tstamp: tstamp,
    });
  };

  /**
   * Commit the ecommerce transaction
   *
   * This call will send the data specified with addTrans,
   * addItem methods to the tracking server.
   */
  apiMethods.trackTrans = function () {
    logTransaction(
      ecommerceTransaction.transaction.orderId,
      ecommerceTransaction.transaction.affiliation,
      ecommerceTransaction.transaction.total,
      ecommerceTransaction.transaction.tax,
      ecommerceTransaction.transaction.shipping,
      ecommerceTransaction.transaction.city,
      ecommerceTransaction.transaction.state,
      ecommerceTransaction.transaction.country,
      ecommerceTransaction.transaction.currency,
      ecommerceTransaction.transaction.context,
      ecommerceTransaction.transaction.tstamp
    );
    for (var i = 0; i < ecommerceTransaction.items.length; i++) {
      var item = ecommerceTransaction.items[i];
      logTransactionItem(
        item.orderId,
        item.sku,
        item.name,
        item.category,
        item.price,
        item.quantity,
        item.currency,
        item.context,
        item.tstamp
      );
    }

    ecommerceTransaction = ecommerceTransactionTemplate();
  };

  /**
   * Track an ad being served
   *
   * @param string impressionId Identifier for a particular ad impression
   * @param string costModel The cost model. 'cpa', 'cpc', or 'cpm'
   * @param number cost Cost
   * @param string bannerId Identifier for the ad banner displayed
   * @param string zoneId Identifier for the ad zone
   * @param string advertiserId Identifier for the advertiser
   * @param string campaignId Identifier for the campaign which the banner belongs to
   * @param object Custom context relating to the event
   * @param tstamp number or Timestamp object
   */
  apiMethods.trackAdImpression = function (
    impressionId,
    costModel,
    cost,
    targetUrl,
    bannerId,
    zoneId,
    advertiserId,
    campaignId,
    context,
    tstamp
  ) {
    core.trackAdImpression(
      impressionId,
      costModel,
      cost,
      targetUrl,
      bannerId,
      zoneId,
      advertiserId,
      campaignId,
      context,
      tstamp
    );
  };

  /**
   * Track an ad being clicked
   *
   * @param string clickId Identifier for the ad click
   * @param string costModel The cost model. 'cpa', 'cpc', or 'cpm'
   * @param number cost Cost
   * @param string targetUrl (required) The link's target URL
   * @param string bannerId Identifier for the ad banner displayed
   * @param string zoneId Identifier for the ad zone
   * @param string impressionId Identifier for a particular ad impression
   * @param string advertiserId Identifier for the advertiser
   * @param string campaignId Identifier for the campaign which the banner belongs to
   * @param object Custom context relating to the event
   * @param tstamp number or Timestamp object
   */
  apiMethods.trackAdClick = function (
    targetUrl,
    clickId,
    costModel,
    cost,
    bannerId,
    zoneId,
    impressionId,
    advertiserId,
    campaignId,
    context,
    tstamp
  ) {
    core.trackAdClick(
      targetUrl,
      clickId,
      costModel,
      cost,
      bannerId,
      zoneId,
      impressionId,
      advertiserId,
      campaignId,
      context,
      tstamp
    );
  };

  /**
   * Track an ad conversion event
   *
   * @param string conversionId Identifier for the ad conversion event
   * @param number cost Cost
   * @param string category The name you supply for the group of objects you want to track
   * @param string action A string that is uniquely paired with each category
   * @param string property Describes the object of the conversion or the action performed on it
   * @param number initialValue Revenue attributable to the conversion at time of conversion
   * @param string advertiserId Identifier for the advertiser
   * @param string costModel The cost model. 'cpa', 'cpc', or 'cpm'
   * @param string campaignId Identifier for the campaign which the banner belongs to
   * @param object Custom context relating to the event
   * @param tstamp number or Timestamp object
   */
  apiMethods.trackAdConversion = function (
    conversionId,
    costModel,
    cost,
    category,
    action,
    property,
    initialValue,
    advertiserId,
    campaignId,
    context,
    tstamp
  ) {
    core.trackAdConversion(
      conversionId,
      costModel,
      cost,
      category,
      action,
      property,
      initialValue,
      advertiserId,
      campaignId,
      context,
      tstamp
    );
  };

  /**
   * Track a social interaction event
   *
   * @param string action (required) Social action performed
   * @param string network (required) Social network
   * @param string target Object of the social action e.g. the video liked, the tweet retweeted
   * @param object Custom context relating to the event
   * @param tstamp number or Timestamp object
   */
  apiMethods.trackSocialInteraction = function (action, network, target, context, tstamp) {
    core.trackSocialInteraction(action, network, target, context, tstamp);
  };

  /**
   * Track an add-to-cart event
   *
   * @param string sku Required. Item's SKU code.
   * @param string name Optional. Product name.
   * @param string category Optional. Product category.
   * @param string unitPrice Optional. Product price.
   * @param string quantity Required. Quantity added.
   * @param string currency Optional. Product price currency.
   * @param array context Optional. Context relating to the event.
   * @param tstamp number or Timestamp object
   */
  apiMethods.trackAddToCart = function (sku, name, category, unitPrice, quantity, currency, context, tstamp) {
    core.trackAddToCart(sku, name, category, unitPrice, quantity, currency, context, tstamp);
  };

  /**
   * Track a remove-from-cart event
   *
   * @param string sku Required. Item's SKU code.
   * @param string name Optional. Product name.
   * @param string category Optional. Product category.
   * @param string unitPrice Optional. Product price.
   * @param string quantity Required. Quantity removed.
   * @param string currency Optional. Product price currency.
   * @param array context Optional. Context relating to the event.
   * @param tstamp Opinal number or Timestamp object
   */
  apiMethods.trackRemoveFromCart = function (sku, name, category, unitPrice, quantity, currency, context, tstamp) {
    core.trackRemoveFromCart(sku, name, category, unitPrice, quantity, currency, context, tstamp);
  };

  /**
   * Track an internal search event
   *
   * @param array terms Search terms
   * @param object filters Search filters
   * @param number totalResults Number of results
   * @param number pageResults Number of results displayed on page
   * @param array context Optional. Context relating to the event.
   * @param tstamp Opinal number or Timestamp object
   */
  apiMethods.trackSiteSearch = function (terms, filters, totalResults, pageResults, context, tstamp) {
    core.trackSiteSearch(terms, filters, totalResults, pageResults, context, tstamp);
  };

  /**
   * Track a timing event (such as the time taken for a resource to load)
   *
   * @param string category Required.
   * @param string variable Required.
   * @param number timing Required.
   * @param string label Optional.
   * @param array context Optional. Context relating to the event.
   * @param tstamp Opinal number or Timestamp object
   */
  apiMethods.trackTiming = function (category, variable, timing, label, context, tstamp) {
    core.trackSelfDescribingEvent(
      {
        schema: 'iglu:com.snowplowanalytics.snowplow/timing/jsonschema/1-0-0',
        data: {
          category: category,
          variable: variable,
          timing: timing,
          label: label,
        },
      },
      context,
      tstamp
    );
  };

  /**
   * Track a consent withdrawn action
   *
   * @param {boolean} all - Indicates user withdraws all consent regardless of context documents.
   * @param {string} [id] - Number associated with document.
   * @param {string} [version] - Document version number.
   * @param {string} [name] - Document name.
   * @param {string} [description] - Document description.
   * @param {array} [context] - Context relating to the event.
   * @param {number|Timestamp} [tstamp] - Number or Timestamp object.
   */
  apiMethods.trackConsentWithdrawn = function (all, id, version, name, description, context, tstamp) {
    core.trackConsentWithdrawn(all, id, version, name, description, context, tstamp);
  };

  /**
   * Track a consent granted action
   *
   * @param {string} id - ID number associated with document.
   * @param {string} version - Document version number.
   * @param {string} [name] - Document name.
   * @param {string} [description] - Document description.
   * @param {string} [expiry] - Date-time when consent document(s) expire.
   * @param {array} [context] - Context containing consent documents.
   * @param {Timestamp|number} [tstamp] - number or Timestamp object.
   */
  apiMethods.trackConsentGranted = function (id, version, name, description, expiry, context, tstamp) {
    core.trackConsentGranted(id, version, name, description, expiry, context, tstamp);
  };

  /**
   * Track a GA Enhanced Ecommerce Action with all stored
   * Enhanced Ecommerce contexts
   *
   * @param string action
   * @param array context Optional. Context relating to the event.
   * @param tstamp Opinal number or Timestamp object
   */
  apiMethods.trackEnhancedEcommerceAction = function (action, context, tstamp) {
    var combinedEnhancedEcommerceContexts = enhancedEcommerceContexts.concat(context || []);
    enhancedEcommerceContexts.length = 0;

    core.trackSelfDescribingEvent(
      {
        schema: 'iglu:com.google.analytics.enhanced-ecommerce/action/jsonschema/1-0-0',
        data: {
          action: action,
        },
      },
      combinedEnhancedEcommerceContexts,
      tstamp
    );
  };

  /**
   * Adds a GA Enhanced Ecommerce Action Context
   *
   * @param string id
   * @param string affiliation
   * @param number revenue
   * @param number tax
   * @param number shipping
   * @param string coupon
   * @param string list
   * @param integer step
   * @param string option
   * @param string currency
   */
  apiMethods.addEnhancedEcommerceActionContext = function (
    id,
    affiliation,
    revenue,
    tax,
    shipping,
    coupon,
    list,
    step,
    option,
    currency
  ) {
    enhancedEcommerceContexts.push({
      schema: 'iglu:com.google.analytics.enhanced-ecommerce/actionFieldObject/jsonschema/1-0-0',
      data: {
        id: id,
        affiliation: affiliation,
        revenue: parseAndValidateFloat(revenue),
        tax: parseAndValidateFloat(tax),
        shipping: parseAndValidateFloat(shipping),
        coupon: coupon,
        list: list,
        step: parseAndValidateInt(step),
        option: option,
        currency: currency,
      },
    });
  };

  /**
   * Adds a GA Enhanced Ecommerce Impression Context
   *
   * @param string id
   * @param string name
   * @param string list
   * @param string brand
   * @param string category
   * @param string variant
   * @param integer position
   * @param number price
   * @param string currency
   */
  apiMethods.addEnhancedEcommerceImpressionContext = function (
    id,
    name,
    list,
    brand,
    category,
    variant,
    position,
    price,
    currency
  ) {
    enhancedEcommerceContexts.push({
      schema: 'iglu:com.google.analytics.enhanced-ecommerce/impressionFieldObject/jsonschema/1-0-0',
      data: {
        id: id,
        name: name,
        list: list,
        brand: brand,
        category: category,
        variant: variant,
        position: parseAndValidateInt(position),
        price: parseAndValidateFloat(price),
        currency: currency,
      },
    });
  };

  /**
   * Adds a GA Enhanced Ecommerce Product Context
   *
   * @param string id
   * @param string name
   * @param string list
   * @param string brand
   * @param string category
   * @param string variant
   * @param number price
   * @param integer quantity
   * @param string coupon
   * @param integer position
   * @param string currency
   */
  apiMethods.addEnhancedEcommerceProductContext = function (
    id,
    name,
    list,
    brand,
    category,
    variant,
    price,
    quantity,
    coupon,
    position,
    currency
  ) {
    enhancedEcommerceContexts.push({
      schema: 'iglu:com.google.analytics.enhanced-ecommerce/productFieldObject/jsonschema/1-0-0',
      data: {
        id: id,
        name: name,
        list: list,
        brand: brand,
        category: category,
        variant: variant,
        price: parseAndValidateFloat(price),
        quantity: parseAndValidateInt(quantity),
        coupon: coupon,
        position: parseAndValidateInt(position),
        currency: currency,
      },
    });
  };

  /**
   * Adds a GA Enhanced Ecommerce Promo Context
   *
   * @param string id
   * @param string name
   * @param string creative
   * @param string position
   * @param string currency
   */
  apiMethods.addEnhancedEcommercePromoContext = function (id, name, creative, position, currency) {
    enhancedEcommerceContexts.push({
      schema: 'iglu:com.google.analytics.enhanced-ecommerce/promoFieldObject/jsonschema/1-0-0',
      data: {
        id: id,
        name: name,
        creative: creative,
        position: position,
        currency: currency,
      },
    });
  };

  /**
   * All provided contexts will be sent with every event
   *
   * @param contexts Array<ContextPrimitive | ConditionalContextProvider>
   */
  apiMethods.addGlobalContexts = function (contexts) {
    core.addGlobalContexts(contexts);
  };

  /**
   * All provided contexts will no longer be sent with every event
   *
   * @param contexts Array<ContextPrimitive | ConditionalContextProvider>
   */
  apiMethods.removeGlobalContexts = function (contexts) {
    core.removeGlobalContexts(contexts);
  };

  /**
   * Clear all global contexts that are sent with events
   */
  apiMethods.clearGlobalContexts = function () {
    core.clearGlobalContexts();
  };

  /**
   * Stop regenerating `pageViewId` (available from `web_page` context)
   */
  apiMethods.preservePageViewId = function () {
    preservePageViewId = true;
  };

  /**
   * Disables anonymous tracking if active (ie. tracker initialized with `anonymousTracking`)
   * For stateStorageStrategy override, uses supplied value first,
   * falls back to one defined in initial config, otherwise uses cookieAndLocalStorage.
   * @param {string} stateStorageStrategy - Override for state storage
   */
  apiMethods.disableAnonymousTracking = function (stateStorageStrategy) {
    if (stateStorageStrategy) {
      argmap.stateStorageStrategy = stateStorageStrategy;
      argmap.anonymousTracking = false;
      configStateStorageStrategy = getStateStorageStrategy(argmap);
    } else {
      argmap.anonymousTracking = false;
    }

    configAnonymousTracking = getAnonymousTracking(argmap);
    configAnonymousSessionTracking = getAnonymousSessionTracking(argmap);
    configAnonymousServerTracking = getAnonymousServerTracking(argmap);

    outQueue.setUseLocalStorage(
      configStateStorageStrategy == 'localStorage' || configStateStorageStrategy == 'cookieAndLocalStorage'
    );
    outQueue.setAnonymousTracking(configAnonymousServerTracking);

    initializeIdsAndCookies();

    outQueue.executeQueue(); // There might be some events in the queue we've been unable to send in anonymous mode
  };

  /**
   * Enables anonymous tracking (ie. tracker initialized without `anonymousTracking`)
   */
  apiMethods.enableAnonymousTracking = function (anonymousArgs) {
    argmap.anonymousTracking = anonymousArgs || true;

    configAnonymousTracking = getAnonymousTracking(argmap);
    configAnonymousSessionTracking = getAnonymousSessionTracking(argmap);
    configAnonymousServerTracking = getAnonymousServerTracking(argmap);

    // Reset the page view, if not tracking the session, so can't stitch user into new events on the page view id
    if (!configAnonymousSessionTracking) {
      resetPageView();
    }

    outQueue.setAnonymousTracking(configAnonymousServerTracking);
  };

  /**
   * Clears all cookies and local storage containing user and session identifiers
   */
  apiMethods.clearUserData = deleteCookies;

  apiMethods.setDebug = function (isDebug) {
    debug = Boolean(isDebug).valueOf();
    updateReturnMethods();
  };

  // Create guarded methods from apiMethods,
  // and set returnMethods to apiMethods or safeMethods depending on value of debug
  const combinedApiMethods = apiPlugins.reduce((prev, current) => {
    if (current.initialise) {
      current.initialise(core, trackerId, mutSnowplowState);
    }
    return {
      ...prev,
      ...current.apiMethods,
    };
  }, apiMethods);
  safeMethods = productionize(combinedApiMethods);
  updateReturnMethods();

  return returnMethods;
}