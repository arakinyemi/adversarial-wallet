// QR rendering via uqr (zero-dependency generator, approved). White tile
// with a quiet zone so scanners work against the dark theme.

import { useMemo } from "react";
import { renderSVG } from "uqr";

export function QrCode({ value, size = 200 }: { value: string; size?: number }) {
  const svg = useMemo(() => renderSVG(value, { ecc: "M", border: 2 }), [value]);
  return (
    <div
      className="qr"
      style={{ width: size, height: size }}
      // Self-generated SVG from our own encoder — not remote content.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
