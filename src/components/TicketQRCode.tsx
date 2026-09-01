"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function TicketQRCode({ value, label }: { value: string; label: string }) {
  const [source, setSource] = useState("");

  useEffect(() => {
    void QRCode.toDataURL(value, {
      width: 520,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#050505", light: "#ffffff" },
    }).then(setSource);
  }, [value]);

  return (
    <div className="ticket-qr" aria-busy={!source}>
      {source ? (
        <Image
          src={source}
          alt={`QR code for ticket ${label}`}
          width={520}
          height={520}
          unoptimized
        />
      ) : (
        <div className="qr-loading" role="status">Generating QR...</div>
      )}
      <span className="sr-only">Text ticket code: {label}.</span>
      <small>Brightness up. Do not share this code.</small>
    </div>
  );
}
