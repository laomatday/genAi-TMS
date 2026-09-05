-- The application uses set_my_avatar(), which validates the owner-bound Storage URL.
-- Keep this legacy RPC for schema compatibility, but remove client execution rights.
revoke all on function public.update_my_avatar(text) from authenticated;
