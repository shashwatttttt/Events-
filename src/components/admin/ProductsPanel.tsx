"use client";

import { AdminAssetUploadField } from "@/components/admin/AdminAssetUploadField";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import type { EventProduct, SiteData } from "@/types/site";
import { dateTimeLocalInputToIso, formatDateTimeLocalInput } from "@/lib/format";

function uid() {
  return `prod_${crypto.randomUUID()}`;
}

export function ProductsPanel({ site, setSite }: { site: SiteData; setSite: (site: SiteData) => void }) {
  const dialog = useAccessibleDialog();
  function patch(id: string, changes: Partial<EventProduct>) {
    const existing = site.products.find((item) => item.id === id);
    if (!existing) return;
    const nextProducts = site.products.map((item) => item.id === id ? { ...item, ...changes } : item);
    let nextEvents = site.events;
    if (changes.eventId && changes.eventId !== existing.eventId) {
      nextEvents = site.events.map((event) => ({
        ...event,
        productIds: event.id === changes.eventId
          ? [...new Set([...event.productIds, id])]
          : event.productIds.filter((productId) => productId !== id),
      }));
    }
    setSite({ ...site, products: nextProducts, events: nextEvents });
  }

  function add() {
    const event = site.events[0];
    if (!event) return;
    const product: EventProduct = {
      id: uid(),
      eventId: event.id,
      name: "New Event Extra",
      description: "Describe the extra.",
      type: "add_on",
      priceCents: 1500,
      stockQuantity: 50,
      soldQuantity: 0,
      maxPerOrder: 1,
      maxPerCustomer: 1,
      requiresApproval: true,
      requiresTicket: true,
      isRedeemable: true,
      unitsPerPurchase: 1,
      imageUrl: "",
      active: true,
      visibleOnEventPage: true,
    };
    setSite({
      ...site,
      products: [...site.products, product],
      events: site.events.map((item) => item.id === event.id ? { ...item, productIds: [...item.productIds, product.id] } : item),
    });
  }

  async function remove(product: EventProduct) {
    if (!await dialog.confirm({ title: "Delete event product?", description: `Delete ${product.name}? It will be removed from linked events when changes are saved.`, confirmLabel: "Delete product", danger: true })) return;
    setSite({
      ...site,
      products: site.products.filter((item) => item.id !== product.id),
      events: site.events.map((event) => ({ ...event, productIds: event.productIds.filter((id) => id !== product.id) })),
    });
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div><h2>Event products</h2><p>Drink passes, upgrades, table deposits, merch and future event extras.</p></div>
        <button className="button button-primary" onClick={add} type="button">Add product</button>
      </div>
      <div className="admin-product-grid">
        {site.products.map((product) => (
          <article className="admin-card" key={product.id}>
            <div className="admin-card-head"><strong>{product.name}</strong><button className="danger-link" type="button" onClick={() => void remove(product)}>Delete</button></div>
            <label className="admin-field"><span>Event</span><select value={product.eventId} onChange={(e) => patch(product.id, { eventId: e.target.value })}>{site.events.map((event) => <option value={event.id} key={event.id}>{event.title}</option>)}</select></label>
            <div className="admin-grid-two">
              <label className="admin-field"><span>Name</span><input value={product.name} onChange={(e) => patch(product.id, { name: e.target.value })} /></label>
              <label className="admin-field"><span>Type</span><select value={product.type} onChange={(e) => patch(product.id, { type: e.target.value as EventProduct["type"] })}><option>drink_pass</option><option>add_on</option><option>vip_upgrade</option><option>merch</option><option>table_deposit</option></select></label>
              <label className="admin-field"><span>Price AUD</span><input type="number" min="0" step="0.01" value={product.priceCents / 100} onChange={(e) => patch(product.id, { priceCents: Math.round(Number(e.target.value) * 100) })} /></label>
              <label className="admin-field"><span>Stock</span><input type="number" min={product.soldQuantity} value={product.stockQuantity} onChange={(e) => patch(product.id, { stockQuantity: Number(e.target.value) })} /></label>
              <label className="admin-field"><span>Max per order</span><input type="number" min="1" value={product.maxPerOrder} onChange={(e) => patch(product.id, { maxPerOrder: Number(e.target.value) })} /></label>
              <label className="admin-field"><span>Max per customer</span><input type="number" min="1" value={product.maxPerCustomer} onChange={(e) => patch(product.id, { maxPerCustomer: Number(e.target.value) })} /></label>
              <label className="admin-field"><span>Redeemable units per purchase</span><input type="number" min="1" max="100" value={product.unitsPerPurchase || 1} onChange={(e) => patch(product.id, { unitsPerPurchase: Math.max(1, Number(e.target.value)) })} /></label>
              <AdminAssetUploadField label="Image URL" value={product.imageUrl} onChange={(value) => patch(product.id, { imageUrl: value })} accept="image/*" previewType="image" />
              <label className="admin-field"><span>Sales start (Melbourne time)</span><input type="datetime-local" value={formatDateTimeLocalInput(product.salesStartAt, site.settings.timezone)} onChange={(e) => patch(product.id, { salesStartAt: dateTimeLocalInputToIso(e.target.value, site.settings.timezone) })} /></label>
              <label className="admin-field"><span>Sales end (Melbourne time)</span><input type="datetime-local" value={formatDateTimeLocalInput(product.salesEndAt, site.settings.timezone)} onChange={(e) => patch(product.id, { salesEndAt: dateTimeLocalInputToIso(e.target.value, site.settings.timezone) })} /></label>
            </div>
            <label className="admin-field"><span>Description</span><textarea value={product.description} onChange={(e) => patch(product.id, { description: e.target.value })} /></label>
            <div className="toggle-row">
              <label><input type="checkbox" checked={product.active} onChange={(e) => patch(product.id, { active: e.target.checked })} /> Active</label>
              <label><input type="checkbox" checked={product.visibleOnEventPage} onChange={(e) => patch(product.id, { visibleOnEventPage: e.target.checked })} /> Public</label>
              <label><input type="checkbox" checked={product.isRedeemable} onChange={(e) => patch(product.id, { isRedeemable: e.target.checked })} /> Redeemable</label>
              <label><input type="checkbox" checked={product.requiresApproval} onChange={(e) => patch(product.id, { requiresApproval: e.target.checked })} /> Invite allocation required</label>
            </div>
            <p className="admin-field-note">
              Products are currently sold only inside ticket checkout. Standalone product sales are
              not implemented, so the stored ticket-required flag is not editable here.
            </p>
            <small>{product.soldQuantity} purchased</small>
          </article>
        ))}
      </div>
    </section>
  );
}
