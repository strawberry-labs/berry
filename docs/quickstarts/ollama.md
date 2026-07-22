# Ollama in 5 minutes

Use this when you want Berry to run against a local Ollama model with no cloud account.

## Prerequisites

- Berry desktop is installed from the signed release or running from the repo.
- Ollama is installed and the local service is reachable on `http://127.0.0.1:11434`.
- A small chat model is available locally.

## Steps

```sh
ollama pull llama3.2:3b
ollama list
```

Open Berry desktop and go to `Settings > Models`. Add or enable the Ollama provider with:

- Provider type: Ollama
- Base URL: `http://127.0.0.1:11434`
- Auth: none
- Default model: `llama3.2:3b`

Click the provider test action. Continue only after the provider test passes.

Start a task from the desktop or use the CLI after the provider exists in the local Berry database:

```sh
berry run -p "Write a three sentence project summary." --provider ollama --model llama3.2:3b
```

## Confirm it works

- `Settings > Models` shows Ollama enabled.
- The provider test passes against `llama3.2:3b`.
- A new Berry task streams a response without opening a cloud login or API key prompt.

## Troubleshooting

- If the provider test cannot connect, run `curl http://127.0.0.1:11434/api/tags`.
- If the model is missing, run `ollama pull llama3.2:3b` again and re-test.
- If the CLI cannot find the provider id, open the desktop model settings and copy the configured provider id.
