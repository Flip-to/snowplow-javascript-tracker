<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[Home](./index.md) &gt; [@snowplow/node-tracker](./node-tracker.md) &gt; [EventJsonWithKeys](./node-tracker.eventjsonwithkeys.md)

## EventJsonWithKeys type

A tuple which represents the unprocessed JSON to be added to the Payload

<b>Signature:</b>

```typescript
type EventJsonWithKeys = {
    keyIfEncoded: string;
    keyIfNotEncoded: string;
    json: Record<string, unknown>;
};
```
