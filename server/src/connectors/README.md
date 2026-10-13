Watson's Google Calendar, Merge CRM/ATS, and public URL connectors are mounted by the cloud server. The protocol, setup, API, and validation boundaries are documented in [connectors.md](../../../docs/connectors.md).

`index.ts` exports `createConnectorExtension`, `createConnectorContextProvider`, `createConnectorWorker`, and `connectorOptionsFromEnvironment`. The route extension authenticates every request except the single-use Google callback. The context provider returns permitted Merge facts separately from revisioned Watson documents. Stop the worker before closing SQLite.
