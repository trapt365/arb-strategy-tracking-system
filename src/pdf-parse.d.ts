// pdf-parse (1.1.x) не поставляет типы. Нам нужен только текст из буфера.
declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>;
  export = pdfParse;
}
