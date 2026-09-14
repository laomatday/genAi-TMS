-- Finalize Workforce V3 rollout after production frontend deployment.
-- Retire the temporary authenticated EXECUTE compatibility window for the 14
-- legacy RPCs that were briefly re-enabled while the old frontend was live.
revoke all on function public.checkout_attendance_gps(double precision,double precision,double precision) from public, anon, authenticated;
revoke all on function public.close_attendance_period_v1(date,date,text) from public, anon, authenticated;
revoke all on function public.delete_shift_assignment_v1(uuid,text) from public, anon, authenticated;
revoke all on function public.get_employee_directory() from public, anon, authenticated;
revoke all on function public.get_my_attendance() from public, anon, authenticated;
revoke all on function public.record_qr_attendance(text,double precision,double precision,double precision) from public, anon, authenticated;
revoke all on function public.refresh_tms_exceptions_v2(date,date) from public, anon, authenticated;
revoke all on function public.review_attendance_explanation(uuid,text,text) from public, anon, authenticated;
revoke all on function public.review_attendance_request_v2(uuid,text,text) from public, anon, authenticated;
revoke all on function public.review_leave_request(uuid,text,text) from public, anon, authenticated;
revoke all on function public.save_shift_assignments_v1(jsonb) from public, anon, authenticated;
revoke all on function public.submit_attendance_explanation(date,text) from public, anon, authenticated;
revoke all on function public.submit_leave_request(text,date,date,text) from public, anon, authenticated;
revoke all on function public.toggle_attendance_pause() from public, anon, authenticated;
notify pgrst, 'reload schema';;
