/*
 * Copyright (c) 2022 Snowplow Analytics Ltd
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

export {
  newTracker,
  Tracker,
  TrackerConfiguration,
  NodeEmitterConfiguration,
  CustomEmitter,
} from './tracker';

export {
  version,
  buildAdClick,
  buildAdConversion,
  buildAdImpression,
  buildAddToCart,
  buildConsentGranted,
  buildConsentWithdrawn,
  buildEcommerceTransaction,
  buildEcommerceTransactionItem,
  buildFormFocusOrChange,
  buildFormSubmission,
  buildLinkClick,
  buildPagePing,
  buildPageView,
  buildRemoveFromCart,
  buildScreenView,
  buildSelfDescribingEvent,
  buildSiteSearch,
  buildSocialInteraction,
  buildStructEvent,
  AdClickEvent,
  ContextEvent,
  PagePingEvent,
  PageViewEvent,
  AddToCartEvent,
  LinkClickEvent,
  ScreenViewEvent,
  SiteSearchEvent,
  StructuredEvent,
  AdConversionEvent,
  AdImpressionEvent,
  ConsentGrantedEvent,
  FormSubmissionEvent,
  RemoveFromCartEvent,
  SelfDescribingEvent,
  ConsentWithdrawnEvent,
  FormFocusOrChangeEvent,
  SocialInteractionEvent,
  EcommerceTransactionEvent,
  EcommerceTransactionItemEvent,
  SelfDescribingJson,
  Timestamp,
  PayloadBuilder,
  Payload,
  CorePlugin,
  CoreConfiguration,
  ContextGenerator,
  ContextFilter,
  EventPayloadAndContext,
  EventStore,
  EventStoreConfiguration,
  EventStoreIterator,
  EventStorePayload,
  TrackerCore,
  Logger,
  FormElement,
  EmitterConfiguration,
  EmitterConfigurationBase,
  EventJson,
  JsonProcessor,
  TrueTimestamp,
  DeviceTimestamp,
  EventMethod,
  RequestFailure,
  EventBatch,
  EventJsonWithKeys,
  LOG_LEVEL,
  ConditionalContextProvider,
  ContextPrimitive,
  CorePluginConfiguration,
  Emitter,
  FilterProvider,
  RuleSetProvider,
  RuleSet,
} from '@snowplow/tracker-core';
