"use client";

import { useAccessibleDialog } from "@/components/AccessibleDialog";
import type { FormField, SiteData } from "@/types/site";

const uid = () => `field_${crypto.randomUUID()}`;

export function FormsPanel({ site, setSite }: { site: SiteData; setSite: (site: SiteData) => void }) {
  const dialog = useAccessibleDialog();

  function addField(formId: string) {
    const field: FormField = { id: uid(), key: `question_${crypto.randomUUID().replaceAll("-", "_")}`, label: "New question", type: "text", required: false, placeholder: "", options: [], maxLength: 300 };
    setSite({ ...site, forms: site.forms.map((form) => form.id === formId ? { ...form, fields: [...form.fields, field] } : form) });
  }

  function patchField(formId: string, fieldId: string, patch: Partial<FormField>) {
    setSite({ ...site, forms: site.forms.map((form) => form.id === formId ? { ...form, fields: form.fields.map((field) => field.id === fieldId ? { ...field, ...patch } : field) } : form) });
  }

  async function removeField(formId: string, field: FormField) {
    if (!await dialog.confirm({ title: "Remove application field?", description: `Remove ${field.label}? Existing submitted answers remain in operational records, but the question will disappear from future applications after saving.`, confirmLabel: "Remove field", danger: true })) return;
    setSite({ ...site, forms: site.forms.map((form) => form.id === formId ? { ...form, fields: form.fields.filter((item) => item.id !== field.id) } : form) });
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title"><div><h2>Application forms</h2><p>Change invite questions without changing source code.</p></div></div>
      {site.forms.map((form) => (
        <div className="admin-card" key={form.id}>
          <div className="admin-card-head"><div><strong>{form.name}</strong><small>{form.fields.length} fields</small></div><button className="button button-ghost" onClick={() => addField(form.id)} type="button">Add field</button></div>
          <label className="admin-field"><span>Introduction</span><textarea value={form.intro} onChange={(event) => setSite({ ...site, forms: site.forms.map((item) => item.id === form.id ? { ...item, intro: event.target.value } : item) })} /></label>
          {form.fields.map((field) => (
            <div className="form-field-editor" key={field.id}>
              <div className="admin-grid-three">
                <label className="admin-field"><span>Label</span><input value={field.label} onChange={(event) => patchField(form.id, field.id, { label: event.target.value })} /></label>
                <label className="admin-field"><span>Data key</span><input value={field.key} onChange={(event) => patchField(form.id, field.id, { key: event.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase() })} /></label>
                <label className="admin-field"><span>Type</span><select value={field.type} onChange={(event) => patchField(form.id, field.id, { type: event.target.value as FormField["type"] })}><option>text</option><option>email</option><option>phone</option><option>textarea</option><option>select</option><option>radio</option><option>checkbox</option></select></label>
              </div>
              <label className="admin-field"><span>Placeholder / checkbox wording</span><input value={field.placeholder} onChange={(event) => patchField(form.id, field.id, { placeholder: event.target.value })} /></label>
              {["select", "radio"].includes(field.type) && <label className="admin-field"><span>Options - one per line</span><textarea value={field.options.join("\n")} onChange={(event) => patchField(form.id, field.id, { options: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></label>}
              <div className="toggle-row">
                <label><input type="checkbox" checked={field.required} onChange={(event) => patchField(form.id, field.id, { required: event.target.checked })} /> Required</label>
                <button className="danger-link" onClick={() => void removeField(form.id, field)} type="button">Remove</button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
