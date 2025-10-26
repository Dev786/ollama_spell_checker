# backend/main.py
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
import requests, json, re, hashlib, time

OLLAMA_URL = "http://localhost:11434"
MODEL_DEFAULT = "llama3"
TIMEOUT = 60
# Simple in-memory cache (text+model -> (ts, result))
CACHE_TTL = 60  # seconds
CACHE: Dict[str, tuple[float, Any]] = {}

app = FastAPI(title="Ollama Spellcheck API", version="1.0")

# CORS for local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local only; tighten if needed
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SpellcheckRequest(BaseModel):
    text: str
    model: Optional[str] = MODEL_DEFAULT
    # for long text we’ll chunk (server-side) so frontend stays light
    max_chunk_chars: int = 1600

class CorrectRequest(BaseModel):
    text: str
    model: Optional[str] = MODEL_DEFAULT

def _hash_key(model: str, text: str) -> str:
    return hashlib.sha256((model + "||" + text).encode("utf-8")).hexdigest()

def _cache_get(model: str, text: str):
    key = _hash_key(model, text)
    row = CACHE.get(key)
    if not row:
        return None
    ts, val = row
    if (time.time() - ts) > CACHE_TTL:
        CACHE.pop(key, None)
        return None
    return val

def _cache_set(model: str, text: str, value: Any):
    key = _hash_key(model, text)
    CACHE[key] = (time.time(), value)

def _ollama_generate(model: str, prompt: str) -> str:
    """
    Calls Ollama streaming API and returns the concatenated response text.
    """
    url = f"{OLLAMA_URL}/api/generate"
    with requests.post(url, json={"model": model, "prompt": prompt}, stream=True, timeout=TIMEOUT) as r:
        r.raise_for_status()
        chunks = []
        for line in r.iter_lines():
            if not line:
                continue
            try:
                obj = json.loads(line.decode("utf-8"))
                # Each line: {"response": "...", "done": false/true, ...}
                chunks.append(obj.get("response", ""))
            except Exception:
                # ignore malformed
                continue
        return "".join(chunks)

def _extract_json_list(text: str) -> list:
    """
    Extract the first top-level JSON array from a possibly chatty LLM response.
    """
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    snippet = text[start:end+1]
    try:
        return json.loads(snippet)
    except Exception:
        return []

def chunk_text(s: str, max_chars: int) -> List[str]:
    if len(s) <= max_chars:
        return [s]
    splitted_text = s.split(" ")
    # reduce to parts of max_chars
    parts = []
    current_text = ""
    for word in splitted_text:
        if len(current_text) + len(word) + 1 > max_chars:
            parts.append(current_text)
            current_text = " "
        current_text += word + " " 
    
    if current_text:
        parts.append(current_text)
    
    return parts

@app.get("/health")
def health():
    # touch Ollama’s /api/tags to confirm it’s up
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        ok = r.status_code == 200
        return {"ok": ok}
    except Exception:
        return {"ok": False}

@app.get("/models")
def models():
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=10)
        r.raise_for_status()
        data = r.json()
        names = [m["name"] for m in data.get("models", [])]
        return {"models": names}
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch models: {e}")

@app.post("/spellcheck")
def spellcheck(req: SpellcheckRequest):
    """
    Returns [{"word":"xxx","suggestions":["..."],"positions":[[start,end],...]}, ...]
    Positions are best-effort by naive scan (per chunk), merged back to global indices.
    """
    model = req.model or MODEL_DEFAULT
    text = req.text or ""
    cached = _cache_get(model, text)
    if cached is not None:
        return {"corrections": cached}

    chunks = chunk_text(text, req.max_chunk_chars)
    print(chunks)
    corrections_global: Dict[str, Dict[str, Any]] = {}

    offset = 0
    for ch in chunks:
        print('ch:', ch)
        prompt = f"""
        You are a strict spell and grammar checker.
        Your task is to identify every misspelled or grammatically incorrect word in the provided text and return a valid JSON array of corrections.

        Each element in the array must be an object with:
        - "misspelled_word": the exact incorrect word (as it appears in the text)
        - "suggestion": the correct replacement (as a string)

        Output Format:
        [
            {{"misspelled_word": "mispelled", "suggestion": "misspelled"}}
        ]

        Text:
        {ch}

        CRITICAL RULES:
        1. Never return anything except a valid JSON array.
        2. The "suggestion" value must always be a single string — never an array.
        3. Do not modify or auto-correct the input text; only report incorrect words.
        4. Always infer the correct spelling or grammar based on context.
        5. Do not include suggestions for words that are already correct.
        """
        print('prompt:', prompt)
        raw = _ollama_generate(model, prompt)
        arr = _extract_json_list(raw)
        print('arr:', arr)
        # Compute positions per chunk (best-effort exact word matches, case-insensitive)
        for item in arr:
            w = item.get("misspelled_word")
            sugg = item.get("suggestion")
        
            # find all occurrences in this chunk
            positions = []
            
            print("Finding occurrences of:", w)
            for m in re.finditer(rf"\b{re.escape(w)}\b", ch, flags=re.IGNORECASE):
                positions.append([offset + m.start(), offset + m.end()])

            print("Positions:", positions)

            # merge into global dict by lowercase key
            key = w.lower()
            if key not in corrections_global:
                corrections_global[key] = {"word": w, "suggestions": sugg, "positions": positions}
            else:
                # merge positions and suggestions
                corrections_global[key]["positions"].extend(positions)
                # unify suggestions preserving order
                seen = set(corrections_global[key]["suggestions"])
                for s in sugg:
                    if s not in seen:
                        corrections_global[key]["suggestions"].append(s)
                        seen.add(s)
        offset += len(ch)

    result = list(corrections_global.values())
    _cache_set(model, text, result)
    return {"corrections": result}

@app.post("/correct")
def correct(req: CorrectRequest):
    """
    Batch "auto-correct all" — returns corrected full text.
    """
    model = req.model or MODEL_DEFAULT
    text = req.text or ""
    cached = _cache_get(model, "AUTO|" + text)
    if cached is not None:
        return {"text": cached}

    prompt = f"""
Correct spelling and grammar of the following text while preserving tone & meaning.
Return ONLY the corrected text, no JSON, no commentary.

Text:
\"\"\"{text}\"\"\"
"""
    corrected = _ollama_generate(model, prompt).strip()
    _cache_set(model, "AUTO|" + text, corrected)
    return {"text": corrected}
