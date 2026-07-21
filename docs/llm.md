# LLM Configuration & Features

Klugh supports neuro-symbolic reasoning via Large Language Models (LLMs). By hooking the logic engine up to an LLM, you can query models dynamically during logic evaluation and use AI-assisted tools during rule authoring.

---

## Configuration & Setup

You can configure the LLM connection either via environment variables or in your project's configuration file. Environment variables take precedence.

### 1. Using Environment Variables (Recommended)
You can define these in your shell or place them in a `.env` file at your project root:

```bash
# API Keys (Set the one for your chosen provider)
GEMINI_API_KEY="your-gemini-api-key"
OPENAI_API_KEY="your-openai-api-key"
ANTHROPIC_API_KEY="your-anthropic-api-key"

# Provider & Model Settings (Optional overrides)
LLM_PROVIDER="gemini"                 # "gemini" | "openai" | "anthropic"
LLM_MODEL="gemini-2.5-flash"          # Specific model name override
LLM_BASE_URL="https://..."            # Custom API gateway or local server endpoint
```

### 2. Using `project.config.json`
You can declare a project-wide configuration in your `project.config.json` file:

```json
{
  "scenarios": { ... },
  "llm": {
    "provider": "gemini",
    "apiKey": "your-api-key",
    "model": "gemini-2.5-flash",
    "baseURL": "https://generativelanguage.googleapis.com/v1beta/models"
  }
}
```

*Note: For security, keeping keys in a local gitignored `.env` file is preferred over hardcoding them in `project.config.json`.*

---

## Supported Providers & Defaults

| Provider | Environment Key | Default Model | Default Base URL |
|---|---|---|---|
| **Gemini** | `GEMINI_API_KEY` | `gemini-2.5-flash` | `https://generativelanguage.googleapis.com/v1beta/models` |
| **Claude (Anthropic)** | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-latest` | `https://api.anthropic.com/v1` |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-4o-mini` | `https://api.openai.com/v1` |

*Note: The OpenAI provider can also be used to connect to local/custom endpoints like Ollama, vLLM, or LM Studio by overriding `LLM_BASE_URL`.*

---

## What You Get Out of the Deal

Hooking up an LLM unlocks three core features:

### 1. LLM Sensor Predicates (`sensor-llm` / `sensor-llm-numeric`)
Instead of hardcoding boolean logic or numeric thresholds in JavaScript, you can delegate complex, subjective, or real-world classification to an LLM:

```klugh
rule "respect movie stars"
  friendly(?X, ?Y) > 10
  ^ mainCharacterInMovie(?Y)
  => intent-challenge(?X, ?Y) += 1
```

Here, `mainCharacterInMovie(?Y)` is computed on the fly by asking the LLM: *"Was the character 'Y' the main character in a movie?"*. See the [Sensor Predicates Reference](sensors.md) for how to author these logic files.

### 2. Auto-Suggest Rule Names (✨ Suggest)
When writing complex rules in the **Rule Editor** tab of the `action-rule-set-tool`, click the **✨ Suggest** button next to the Rule Name field. 

The LLM will analyze your logic statements and comments, automatically suggesting a clean, concise name that conforms to the project's naming conventions.

### 3. Prompt & Response Provenance
Under Play Mode, every LLM query and response is recorded tick-by-tick. If a rule evaluates unexpectedly, you can open the **Provenance Inspector** and drill down to see the exact prompt sent and the raw API response returned:

```
[Evaluated by LLM]
Friendly(ken, ryu) = 15
LLM response: "Yes"
------------------------------------------------------------
Prompt: Was the character "ryu" the main character in a movie? Answer with ONLY "yes" or "no".
------------------------------------------------------------
```
This ensures that neuro-symbolic elements remain fully explainable and debuggable.
