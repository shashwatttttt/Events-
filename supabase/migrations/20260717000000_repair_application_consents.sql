-- Repair the legacy empty form field and restore explicit optional consent fields.
begin;

with repaired as (
  select
    document.key,
    jsonb_agg(
      case
        when form ->> 'id' = 'form_invite' then
          jsonb_set(
            form,
            '{fields}',
            coalesce(
              (
                select jsonb_agg(field order by field_ordinality)
                from jsonb_array_elements(form -> 'fields')
                  with ordinality as fields(field, field_ordinality)
                where field ? 'id' and field ? 'key'
              ),
              '[]'::jsonb
            )
            || case
              when exists (
                select 1
                from jsonb_array_elements(form -> 'fields') as fields(field)
                where field ->> 'key' = 'media_consent'
              ) then '[]'::jsonb
              else jsonb_build_array(
                jsonb_build_object(
                  'id', 'f_media',
                  'key', 'media_consent',
                  'label', 'Media consent',
                  'type', 'checkbox',
                  'required', false,
                  'placeholder', 'I consent to photos and video of me being used in Skie Events recaps and marketing.',
                  'options', jsonb_build_array()
                )
              )
            end
            || case
              when exists (
                select 1
                from jsonb_array_elements(form -> 'fields') as fields(field)
                where field ->> 'key' = 'sponsor_consent'
              ) then '[]'::jsonb
              else jsonb_build_array(
                jsonb_build_object(
                  'id', 'f_sponsor',
                  'key', 'sponsor_consent',
                  'label', 'Sponsor consent',
                  'type', 'checkbox',
                  'required', false,
                  'placeholder', 'I consent to my contact details being shared with named sponsors of this event.',
                  'options', jsonb_build_array()
                )
              )
            end
          )
        else form
      end
      order by form_ordinality
    ) as forms
  from public.platform_documents as document
  cross join lateral jsonb_array_elements(document.payload -> 'forms')
    with ordinality as form_rows(form, form_ordinality)
  where document.key = 'site'
  group by document.key
)
update public.platform_documents as document
set payload = jsonb_set(document.payload, '{forms}', repaired.forms),
    version = document.version + 1,
    updated_at = now()
from repaired
where document.key = repaired.key;

commit;
