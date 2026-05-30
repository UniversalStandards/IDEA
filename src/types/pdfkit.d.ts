declare module 'pdfkit' {
  class PDFDocument {
    pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
    fontSize(size: number): this;
    text(text: string): this;
    moveDown(): this;
    end(): void;
    on(event: string, handler: (...args: unknown[]) => void): this;
  }

  export default PDFDocument;
}
