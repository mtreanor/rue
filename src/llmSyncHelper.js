// Synchronous LLM call helper spawned as a child process
import { env, argv, exit } from 'process';

async function run() {
  const prompt = argv[2];
  if (!prompt) {
    console.error('Error: No prompt provided');
    exit(1);
  }

  const llmConf = env.KLUGH_LLM_CONFIG ? JSON.parse(env.KLUGH_LLM_CONFIG) : {};
  const apiKey = env.GEMINI_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || llmConf.apiKey;
  if (!apiKey) {
    console.error('Error: LLM API Key not found. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY');
    exit(1);
  }

  let provider = 'gemini';
  if (env.LLM_PROVIDER) {
    provider = env.LLM_PROVIDER;
  } else if (env.OPENAI_API_KEY) {
    provider = 'openai';
  } else if (env.ANTHROPIC_API_KEY) {
    provider = 'anthropic';
  } else if (llmConf.provider) {
    provider = llmConf.provider;
  }

  let model = env.LLM_MODEL || llmConf.model;
  let baseURL = env.LLM_BASE_URL || llmConf.baseURL;

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
      console.error(`Gemini API error: ${res.status} ${res.statusText} - ${errText}`);
      exit(1);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error(`Invalid response from Gemini API: ${JSON.stringify(data)}`);
      exit(1);
    }
    console.log(text.trim());
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
      console.error(`Anthropic API error: ${res.status} ${res.statusText} - ${errText}`);
      exit(1);
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text;
    if (!text) {
      console.error(`Invalid response from Anthropic API: ${JSON.stringify(data)}`);
      exit(1);
    }
    console.log(text.trim());
  } else {
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
      console.error(`OpenAI API error: ${res.status} ${res.statusText} - ${errText}`);
      exit(1);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      console.error(`Invalid response from OpenAI API: ${JSON.stringify(data)}`);
      exit(1);
    }
    console.log(text.trim());
  }
}

run().catch(err => {
  console.error('Execution error:', err.message);
  exit(1);
});
