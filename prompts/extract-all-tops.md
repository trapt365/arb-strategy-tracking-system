Extract ALL people from the text below as a JSON array.

Text: {{text}}

Return a JSON array of objects with exactly these fields per object:
- "name": string (required)
- "title": string or null (job title / role)
- "authority": string or null (scope of authority / responsibilities)
- "area": string or null (area of responsibility / zone)

Rules:
- Include every distinct person mentioned. Do NOT invent values not in the text.
- If a field cannot be identified, set it to null.
- Return only the JSON array, no extra text.
