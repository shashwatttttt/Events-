-- Release marker used to execute the production migration and worker workflows
-- after the deep operations reliability hardening was validated.

begin;
notify pgrst, 'reload schema';
commit;
