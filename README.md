# @nistrix-ltda/chat

The Nistrix chat for your own site or app: your visitors talk to your Nistrix agents and team, in a screen you design. It runs in browsers and in React Native, with no other dependency.

It uses a **publishable key** (`nx_pk_live_...`, or `nx_pk_test_...` in your test environment). It is not a secret: it can only open visitor chats on one chat channel, from the sites and apps you listed on it. Never put a secret key (`nx_sk_`, `nx_rk_`) in a site or app.

## Get a key

In Nistrix, **Integrations → API and MCP → Nistrix in your apps → Publishable keys**: choose the chat channel, list your sites (`https://shop.example`) and apps (`com.shop.app`), and copy the key.

## Use it

```ts
import { NistrixChat } from "@nistrix-ltda/chat";

const chat = new NistrixChat({
  publishableKey: "nx_pk_live_...",
  storage: window.localStorage, // keeps the visitor between visits
});

const history = await chat.messages();
await chat.send("Hi, can I book a time?", { name: "Bia" });

const stop = chat.subscribe((messages) => render(messages)); // the agent or team wrote
// later: stop();
```

### React Native

Native apps have no origin, so they name themselves with `appId` (the bundle id or package name listed on the key):

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";

const chat = new NistrixChat({
  publishableKey: "nx_pk_live_...",
  appId: "com.shop.app",
  storage: AsyncStorage,
});
```

## Errors

Calls throw `ChatError` with the HTTP `status` and the API's `code`, for example `origin-not-allowed` (add the site or app to the key) or `rate-limited`.

## Test environment

A `nx_pk_test_` key from your sandbox works the same way; conversations land in the sandbox, and `chat.test` is `true`.

## Develop

```bash
pnpm install
pnpm test
pnpm build
```
