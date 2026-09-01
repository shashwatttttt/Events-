import Link from "next/link";
export default function NotFound(){return <section className="status-page"><div className="status-symbol">404</div><p className="eyebrow"><span/>Wrong room</p><h1>This page left early.</h1><p>The link may have changed or the event is no longer public.</p><div><Link className="button button-primary" href="/">Return home <span>↗</span></Link></div></section>;}
