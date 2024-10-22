<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[Home](./index.md) &gt; [@snowplow/browser-tracker](./browser-tracker.md) &gt; [LocalStorageEventStoreConfigurationBase](./browser-tracker.localstorageeventstoreconfigurationbase.md) &gt; [maxLocalStorageQueueSize](./browser-tracker.localstorageeventstoreconfigurationbase.maxlocalstoragequeuesize.md)

## LocalStorageEventStoreConfigurationBase.maxLocalStorageQueueSize property

The maximum amount of events that will be buffered in local storage

This is useful to ensure the Tracker doesn't fill the 5MB or 10MB available to each website should the collector be unavailable due to lost connectivity. Will drop events once the limit is hit

<b>Signature:</b>

```typescript
maxLocalStorageQueueSize?: number;
```