export default function PdfDocumentViewer({ src, name }: { src: string; name: string }) {
  return (
    <iframe
      className="berry-native-pdf-viewer"
      src={`${src}#toolbar=1&navpanes=0&view=FitH`}
      title={`Preview of ${name}`}
    />
  );
}
