"use client";

import { useState } from "react";

export function PublicImageLayer({
  src,
  alt,
  className,
  imageClassName,
  overlayClassName,
}: {
  src: string;
  alt: string;
  className: string;
  imageClassName: string;
  overlayClassName?: string;
}) {
  const [failedSrc, setFailedSrc] = useState("");
  if (!src || failedSrc === src) return null;

  return (
    <span className={className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={imageClassName}
        src={src}
        alt={alt}
        onError={() => setFailedSrc(src)}
      />
      {overlayClassName && <span className={overlayClassName} aria-hidden="true" />}
    </span>
  );
}
