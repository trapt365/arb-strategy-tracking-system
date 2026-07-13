Extract the top-manager fields from the phrase below.

Phrase: {{phrase}}

Return a JSON object with exactly these fields:
- "name": string (required — the person's name; take the most prominent name-like token)
- "title": string or null (job title / role; null if not mentioned)
- "authority": string or null (scope of authority / responsibilities; null if not mentioned)
- "area": string or null (area of responsibility / zone; null if not mentioned)

Rules:
- Do NOT invent values that are not present in the phrase.
- If a field cannot be identified, set it to null.
- Return only the JSON object, no extra text.
