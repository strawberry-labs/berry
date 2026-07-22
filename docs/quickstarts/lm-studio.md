# LM Studio

Use this when LM Studio owns local model download and serving, while Berry connects through the OpenAI-compatible local server.

## Prerequisites

- LM Studio is installed.
- A chat-capable model is downloaded in LM Studio.
- Berry desktop can reach the machine running LM Studio.

## Steps

In LM Studio:

1. Open the Developer or Local Server view.
2. Load the model you want Berry to use.
3. Start the OpenAI-compatible Local Server.
4. Confirm the server URL, usually `http://127.0.0.1:1234/v1`.

In Berry desktop, open `Settings > Models` and add a provider:

- Provider type: OpenAI-compatible
- Name: LM Studio
- Base URL: `http://127.0.0.1:1234/v1`
- Auth: none
- Default model: the LM Studio model id shown by the local server

Run the Berry provider test. Continue only after the provider test passes.

## Confirm it works

```sh
curl http://127.0.0.1:1234/v1/models
berry run -p "Reply with the model name you are using." --provider lm-studio
```

- LM Studio shows a request in its server log.
- Berry streams a response in the task.
- The provider test passes after Berry is restarted.

## Notes

LM Studio model ids can change when a different model is loaded. If Berry reports a model-not-found error, update the provider default model in `Settings > Models` and run the provider test again.
