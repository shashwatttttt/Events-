"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import type { SessionUser } from "@/types/site";

const links = [
  ["Events", "/events"],
  ["Previous", "/previous-events"],
  ["Media", "/media"],
  ["Reviews", "/reviews"],
  ["About", "/about"],
  ["Contact", "/contact"],
] as const;

export function SiteHeader({ user, brandName }: { user?: SessionUser | null; brandName?: string }) {
  const pathname = usePathname();
  const [prevPathname, setPrevPathname] = useState(pathname);
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => {
      if (event.key==="Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <header className="site-header">
      <div className="shell header-inner">
        <BrandMark name={brandName} />
        <button
          ref={menuButton}
          className={`menu-button${open ? " is-active" : ""}`}
          type="button"
          aria-label={open ? "Close main navigation" : "Open main navigation"}
          aria-expanded={open}
          aria-controls="site-navigation"
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
        {open && (
          <div
            className="mobile-nav-backdrop"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
        )}
        <nav
          aria-label="Main navigation"
          id="site-navigation"
          className={open ? "site-nav is-open" : "site-nav"}
        >
          <div className="mobile-nav-links">
            {links.map(([label, href]) => (
              <Link
                key={href}
                href={href}
                aria-current={pathname===href?"page":undefined}
                className={pathname === href ? "is-active" : ""}
                onClick={() => setOpen(false)}
              >
                {label}
              </Link>
            ))}
            <Link
              href={user ? "/account" : "/login"}
              aria-current={pathname === (user ? "/account" : "/login") ? "page" : undefined}
              className={`nav-account${pathname === (user ? "/account" : "/login") ? " is-active" : ""}`}
              onClick={() => setOpen(false)}
            >
              {user ? "My account" : "Log in"}
            </Link>
          </div>
          <div className="mobile-nav-cta">
            <Link
              href="/events"
              className="button button-primary nav-ticket"
              onClick={() => setOpen(false)}
            >
              Tickets <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </nav>
      </div>
    </header>
  );
}

