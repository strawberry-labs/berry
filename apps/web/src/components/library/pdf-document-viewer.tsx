import * as React from "react";

const MOBILE_PDF_QUERY = "(max-width: 767px)";

export default function PdfDocumentViewer({ src, name }: { src: string; name: string }) {
  const isMobile = React.useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia(MOBILE_PDF_QUERY);
      media.addEventListener("change", notify);
      return () => media.removeEventListener("change", notify);
    },
    () => window.matchMedia(MOBILE_PDF_QUERY).matches,
    () => false,
  );
  // Native browser PDF renderers honour this fragment. FitH takes precedence
  // only on compact screens; desktop always opens at an exact 100% scale.
  const previewSrc = `${src}#${isMobile ? "view=FitH" : "zoom=100"}&toolbar=1&navpanes=0`;

  return (
    <iframe
      className="berry-native-pdf-viewer"
      src={previewSrc}
      title={`Preview of ${name}`}
    />
  );
}
