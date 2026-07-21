import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import child_process from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Locate project.config.json by traversing up from the current directory
function locateConfig() {
  const override = process.env.KLUGH_CONFIG;
  if (override) return resolve(override);
  let dir = __dirname;
  while (true) {
    const candidate = join(dir, 'project.config.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let repoRoot = null;
function getRepoRoot() {
  if (repoRoot) return repoRoot;
  const configPath = locateConfig();
  if (configPath) {
    repoRoot = dirname(configPath);
  } else {
    repoRoot = __dirname;
  }
  return repoRoot;
}

function tryLoadDotEnv(rootPath) {
  const envPath = join(rootPath, '.env');
  if (!existsSync(envPath)) return;

  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
      return;
    } catch (e) {}
  }

  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) {
          process.env[key] = val;
        }
      }
    }
  } catch (e) {}
}

let cachedConfig = null;
export function loadConfig() {
  tryLoadDotEnv(getRepoRoot());
  if (cachedConfig) return cachedConfig;
  const path = locateConfig();
  if (path && existsSync(path)) {
    try {
      cachedConfig = JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      // ignore
    }
  }
  return cachedConfig || {};
}

export function isLlmEnabled() {
  const config = loadConfig();
  if (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) return true;
  return !!config.llm?.apiKey;
}

export async function callLlm(prompt) {
  const config = loadConfig();
  const llmConf = config.llm || {};

  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || llmConf.apiKey;
  if (!apiKey) {
    throw new Error('LLM API Key is not configured. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY in environment or project.config.json');
  }

  let provider = 'gemini';
  if (process.env.LLM_PROVIDER) {
    provider = process.env.LLM_PROVIDER;
  } else if (process.env.OPENAI_API_KEY) {
    provider = 'openai';
  } else if (process.env.ANTHROPIC_API_KEY) {
    provider = 'anthropic';
  } else if (llmConf.provider) {
    provider = llmConf.provider;
  }

  let model = process.env.LLM_MODEL || llmConf.model;
  let baseURL = process.env.LLM_BASE_URL || llmConf.baseURL;

  if (provider === 'gemini') {
    if (!model) model = 'gemini-2.5-flash';
    if (!baseURL) baseURL = 'https://generativelanguage.googleapis.com/v1beta/models';

    const url = `${baseURL}/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error: ${res.status} ${res.statusText} - ${errText}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(`Invalid response from Gemini API: ${JSON.stringify(data)}`);
    }
    return text.trim();
  } else if (provider === 'anthropic') {
    if (!model) model = 'claude-3-5-sonnet-latest';
    if (!baseURL) baseURL = 'https://api.anthropic.com/v1';

    const url = `${baseURL}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error: ${res.status} ${res.statusText} - ${errText}`);
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text;
    if (!text) {
      throw new Error(`Invalid response from Anthropic API: ${JSON.stringify(data)}`);
    }
    return text.trim();
  } else {
    // OpenAI provider: supports OpenAI API, Ollama, local LLM servers, etc.
    if (!model) model = 'gpt-4o-mini';
    if (!baseURL) baseURL = 'https://api.openai.com/v1';

    const url = `${baseURL}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error: ${res.status} ${res.statusText} - ${errText}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error(`Invalid response from OpenAI API: ${JSON.stringify(data)}`);
    }
    return text.trim();
  }
}

export function callLlmSync(prompt) {
  const config = loadConfig();
  const helperPath = join(__dirname, 'llmSyncHelper.js');
  
  // Pass env vars and serialized config for the helper
  const stdout = child_process.execFileSync(process.execPath, [helperPath, prompt], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      KLUGH_LLM_CONFIG: JSON.stringify(config.llm || {})
    }
  });
  return stdout.trim();
}
