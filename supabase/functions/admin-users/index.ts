import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const roles = new Set(["Staff", "Leader", "Manager", "Director", "Admin", "HR", "Kiosk"]);
const managementRoles = new Set(["Leader", "Manager", "Director", "Admin", "HR"]);
const DEFAULT_ANNUAL_LEAVE_DAYS = 12;
const MAX_ANNUAL_LEAVE_DAYS = 365;
const MIN_PASSWORD_LENGTH = 8;
const ACCOUNT_BAN_DURATION = "876000h";
const employeeIdPattern = /^[A-Z0-9_-]{2,40}$/;
const emailPattern = /^\S+@\S+\.\S+$/;

type AdminUserAction = "create" | "update" | "delete" | "upsert" | "invite" | "password-reset";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function cleanText(value: unknown, max = 160) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanList(value: unknown, max = 50) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, 60).toUpperCase())
    .filter(Boolean)
    .slice(0, max);
}

function failure(code: string, error: string, status = 400, context: Record<string, unknown> = {}) {
  console.warn("[admin-users]", JSON.stringify({ code, ...context }));
  return json({ ok: false, code, error }, status);
}

function configuredAuthRedirect(variable: "AUTH_INVITE_REDIRECT_URL" | "AUTH_PASSWORD_RESET_REDIRECT_URL") {
  const value = cleanText(Deno.env.get(variable), 2_048);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol === "https:" || localHttp) return url.toString();
  } catch {
    // Invalid trusted environment configuration falls back to the Supabase Site URL.
  }
  console.error("[admin-users]", JSON.stringify({ code: "INVALID_AUTH_REDIRECT", variable }));
  return undefined;
}

function successfulRpc(data: unknown) {
  return Boolean(data && typeof data === "object" && (data as { ok?: unknown }).ok === true);
}

/** Replaces an employee's capability overrides with exactly what was asked for.
 *  Runs after the profile row exists, because the table's foreign key needs it. */
async function applyCapabilityOverrides(
  admin: ReturnType<typeof createClient>,
  organizationId: string,
  employeeId: string,
  overrides: Map<string, boolean>,
  known: string[],
  { clearExisting }: { clearExisting: boolean },
) {
  // A freshly created employee has no rows to replace, so the clear is skipped
  // there: the common case of an account with no override then performs no write
  // at all and has nothing that can fail.
  if (clearExisting) {
    // Replace only the capabilities the caller could actually see. An older
    // browser that predates a newly added capability must not delete an override
    // it never rendered and therefore could not send back.
    const { error: clearError } = await admin
      .from("workforce_employee_capabilities")
      .delete()
      .eq("organization_id", organizationId)
      .eq("employee_id", employeeId)
      .in("capability", known);
    if (clearError) return clearError;
  }
  if (!overrides.size) return null;
  const { error: insertError } = await admin
    .from("workforce_employee_capabilities")
    .insert([...overrides].map(([capability, enabled]) => ({
      organization_id: organizationId,
      employee_id: employeeId,
      capability,
      enabled,
    })));
  return insertError;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("authorization");
  if (!url || !serviceRoleKey || !authorization?.startsWith("Bearer ")) {
    return json({ ok: false, error: "Không đủ thông tin xác thực." }, 401);
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const jwt = authorization.slice("Bearer ".length);
  const { data: authData, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !authData.user) return json({ ok: false, error: "Phiên đăng nhập không hợp lệ." }, 401);

  const { data: operator, error: operatorError } = await admin
    .from("employees")
    .select("employee_id,role,status,organization_id")
    .eq("auth_user_id", authData.user.id)
    .single();
  if (operatorError || operator?.role !== "Admin" || operator?.status !== "Active" || !operator.organization_id) {
    return json({ ok: false, error: "Chỉ Admin đang hoạt động được quản lý tài khoản." }, 403);
  }
  const organizationId = operator.organization_id;
  const { data: employeeOverride, error: employeeOverrideError } = await admin
    .from("workforce_employee_capabilities")
    .select("enabled")
    .eq("organization_id", organizationId)
    .eq("employee_id", operator.employee_id)
    .eq("capability", "employee.manage")
    .maybeSingle();
  if (employeeOverrideError) return failure("CAPABILITY_CHECK_FAILED", "Không kiểm tra được quyền quản lý tài khoản.", 500);
  let canManageEmployees = employeeOverride?.enabled;
  if (canManageEmployees === undefined) {
    const { data: roleCapability, error: roleCapabilityError } = await admin
      .from("workforce_role_capabilities")
      .select("enabled")
      .eq("organization_id", organizationId)
      .eq("role", operator.role)
      .eq("capability", "employee.manage")
      .maybeSingle();
    if (roleCapabilityError) return failure("CAPABILITY_CHECK_FAILED", "Không kiểm tra được quyền quản lý tài khoản.", 500);
    canManageEmployees = roleCapability?.enabled ?? false;
  }
  if (!canManageEmployees) return failure("CAPABILITY_DENIED", "Tài khoản không có quyền quản lý nhân sự.", 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Dữ liệu gửi lên không hợp lệ." }, 400);
  }

  const requestedAction = String(body.action || "");
  const expectedAction = String(body.expected_action || "");
  const input = (body.employee || {}) as Record<string, unknown>;
  if (
    requestedAction !== "create"
    && requestedAction !== "update"
    && requestedAction !== "delete"
    && requestedAction !== "upsert"
    && requestedAction !== "invite"
    && requestedAction !== "password-reset"
  ) {
    return failure("INVALID_ACTION", "Thao tác không hợp lệ.");
  }
  let action = requestedAction as AdminUserAction;

  const employeeId = cleanText(input.employee_id, 40).toUpperCase();
  if (!employeeIdPattern.test(employeeId)) {
    return failure("INVALID_EMPLOYEE_ID", "Mã nhân viên cần từ 2–40 ký tự, chỉ gồm chữ, số, gạch ngang hoặc gạch dưới.", 400, { action });
  }

  // An import response may be interrupted after the create committed. Resolve
  // retries against the authoritative tenant row so importing the same file
  // reconciles that employee instead of stopping at a duplicate-id error.
  if (action === "upsert") {
    if (expectedAction !== "create" && expectedAction !== "update") {
      return failure("INVALID_EXPECTED_ACTION", "Thiếu trạng thái đối soát của dòng Excel.", 400, { employeeId });
    }
    const { data: currentEmployee, error: currentEmployeeError } = await admin
      .from("employees")
      .select("employee_id,email")
      .eq("employee_id", employeeId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (currentEmployeeError) {
      return failure("EMPLOYEE_RECONCILE_FAILED", "Không đối soát được trạng thái nhân viên trước khi nhập lại.", 500, { employeeId });
    }
    if (currentEmployee && expectedAction === "create") {
      const requestedEmail = cleanText(input.email, 255).toLowerCase();
      if (String(currentEmployee.email || "").trim().toLowerCase() !== requestedEmail) {
        return failure(
          "EMPLOYEE_RECONCILE_CONFLICT",
          "Mã nhân viên đã xuất hiện với email khác. Dòng này không được tự động ghi đè; hãy tải lại file và kiểm tra hồ sơ hiện tại.",
          409,
          { employeeId },
        );
      }
    }
    if (!currentEmployee && expectedAction === "update") {
      return failure(
        "EMPLOYEE_RECONCILE_MISSING",
        "Hồ sơ cần cập nhật không còn tồn tại. Dòng này không được tự động chuyển thành tài khoản mới.",
        409,
        { employeeId },
      );
    }
    action = currentEmployee ? "update" : "create";
  }

  if (action === "password-reset") {
    const { data: target, error: targetError } = await admin
      .from("employees")
      .select("employee_id,auth_user_id,email,status")
      .eq("employee_id", employeeId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (targetError) {
      return failure("PASSWORD_RESET_TARGET_FAILED", "Không kiểm tra được tài khoản cần đặt lại mật khẩu.", 500, { action, employeeId });
    }
    if (!target) return failure("EMPLOYEE_NOT_FOUND", "Không tìm thấy nhân viên trong tổ chức hiện tại.", 404, { action, employeeId });
    if (target.status !== "Active" || !target.auth_user_id) {
      return failure("PASSWORD_RESET_UNAVAILABLE", "Tài khoản chưa hoạt động hoặc chưa có phương thức đăng nhập email.", 409, { action, employeeId });
    }

    const { data: authTarget, error: authTargetError } = await admin.auth.admin.getUserById(target.auth_user_id);
    const authEmail = String(authTarget.user?.email || "").trim().toLowerCase();
    if (authTargetError || !authTarget.user || !emailPattern.test(authEmail)) {
      return failure("PASSWORD_RESET_AUTH_LOOKUP_FAILED", "Không tìm thấy phương thức đăng nhập email của tài khoản.", 409, {
        action,
        employeeId,
        authCode: authTargetError?.code,
      });
    }
    if (authEmail !== String(target.email || "").trim().toLowerCase()) {
      console.warn("[admin-users]", JSON.stringify({ code: "PASSWORD_RESET_EMAIL_DRIFT", employeeId }));
    }

    const redirectTo = configuredAuthRedirect("AUTH_PASSWORD_RESET_REDIRECT_URL");
    // resetPasswordForEmail asks Supabase Auth to deliver the recovery email and
    // returns no action link/OTP. generateLink is intentionally not used without
    // a server-side mailer because its response contains reusable credentials.
    const { error: resetError } = await admin.auth.resetPasswordForEmail(
      authEmail,
      redirectTo ? { redirectTo } : {},
    );
    if (resetError) {
      return failure("PASSWORD_RESET_DELIVERY_FAILED", "Không gửi được email đặt lại mật khẩu.", 502, {
        action,
        employeeId,
        authCode: resetError.code,
      });
    }

    const { error: auditError } = await admin.from("audit_logs").insert({
      actor_employee_id: operator.employee_id,
      target_employee_id: employeeId,
      action: "EMPLOYEE_PASSWORD_RESET_REQUESTED",
      entity_type: "employee",
      entity_id: employeeId,
      reason: "Admin gửi email đặt lại mật khẩu",
      metadata: { organization_id: organizationId, delivery: "supabase_auth_email" },
    });
    if (auditError) {
      console.error("[admin-users]", JSON.stringify({ code: "PASSWORD_RESET_AUDIT_FAILED", employeeId, databaseCode: auditError.code }));
      return json({
        ok: false,
        code: "PASSWORD_RESET_AUDIT_FAILED",
        error: "Email đã được gửi nhưng nhật ký kiểm toán chưa được ghi nhận.",
        commit_state: "EMAIL_SENT_AUDIT_PENDING",
        retryable: false,
      }, 500);
    }
    return json({ ok: true, employee_id: employeeId, delivery: "email" });
  }

  if (action === "delete") {
    const { data: target, error: targetError } = await admin
      .from("employees")
      .select("employee_id,auth_user_id,role,status,organization_id")
      .eq("employee_id", employeeId)
      .eq("organization_id", organizationId)
      .single();
    if (targetError || !target) {
      return failure("EMPLOYEE_NOT_FOUND", "Không tìm thấy nhân viên trong tổ chức hiện tại.", 404, { action, employeeId });
    }
    if (operator.employee_id === employeeId) {
      return failure("SELF_DELETE_FORBIDDEN", "Không thể xóa tài khoản Admin đang đăng nhập.", 400, { action, employeeId });
    }
    if (target.role === "Admin" && target.status === "Active") {
      const { count, error: countError } = await admin
        .from("employees")
        .select("employee_id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("role", "Admin")
        .eq("status", "Active");
      if (countError) return failure("ADMIN_COUNT_FAILED", "Không kiểm tra được số tài khoản Admin.", 500, { action, employeeId });
      if ((count || 0) <= 1) {
        return failure("LAST_ADMIN_FORBIDDEN", "Không thể xóa Admin hoạt động cuối cùng của tổ chức.", 400, { action, employeeId });
      }
    }

    const deletedAt = new Date().toISOString();
    const { error: deactivateError } = await admin
      .from("employees")
      .update({ status: "Inactive", updated_at: deletedAt })
      .eq("employee_id", employeeId)
      .eq("organization_id", organizationId);
    if (deactivateError) {
      return failure("EMPLOYEE_DEACTIVATE_FAILED", "Không thể vô hiệu hóa hồ sơ trước khi xóa tài khoản.", 500, { action, employeeId });
    }

    const { data: deviceResetData, error: deviceResetError } = await admin.rpc("reset_trusted_device_v1", {
      p_employee_id: employeeId,
      p_actor_employee_id: operator.employee_id,
      p_reason: "Xóa tài khoản đăng nhập",
    });
    if (deviceResetError || !successfulRpc(deviceResetData)) {
      console.error("[admin-users]", JSON.stringify({
        code: "DELETE_DEVICE_RESET_FAILED",
        employeeId,
        databaseCode: deviceResetError?.code,
      }));
      return json({
        ok: false,
        code: "DELETE_DEVICE_RESET_FAILED",
        error: "Hồ sơ đã bị vô hiệu hóa nhưng trạng thái thiết bị chưa được thu hồi đầy đủ.",
        commit_state: "PROFILE_DISABLED_DEVICE_RESET_PENDING",
        retryable: true,
      }, 500);
    }

    if (target.auth_user_id) {
      const { error: banError } = await admin.auth.admin.updateUserById(target.auth_user_id, {
        ban_duration: ACCOUNT_BAN_DURATION,
      });
      if (banError) {
        return failure("AUTH_BLOCK_FAILED", "Không thể khóa tài khoản đăng nhập trước khi xóa.", 502, { action, employeeId });
      }
      const { error: deleteError } = await admin.auth.admin.deleteUser(target.auth_user_id);
      if (deleteError) {
        return failure("AUTH_DELETE_FAILED", deleteError.message || "Không thể xóa tài khoản đăng nhập.", 502, { action, employeeId });
      }
    }

    const { error: unlinkError } = await admin.from("employees").update({
      auth_user_id: null,
      status: "Inactive",
      trusted_device_id: null,
      trusted_device_bound_at: null,
      updated_at: deletedAt,
    }).eq("employee_id", employeeId).eq("organization_id", organizationId);
    if (unlinkError) {
      return failure("EMPLOYEE_UNLINK_FAILED", "Tài khoản Auth đã xóa nhưng chưa thể cập nhật hồ sơ nhân viên.", 500, { action, employeeId });
    }

    const { error: auditError } = await admin.from("audit_logs").insert({
      actor_employee_id: operator.employee_id,
      target_employee_id: employeeId,
      action: "EMPLOYEE_ACCOUNT_DELETED",
      entity_type: "employee",
      entity_id: employeeId,
      reason: "Xóa tài khoản đăng nhập; bảo toàn hồ sơ và dữ liệu chấm công",
      metadata: { previous_role: target.role, previous_status: target.status, organization_id: organizationId },
    });
    if (auditError) console.error("[admin-users]", JSON.stringify({ code: "DELETE_AUDIT_FAILED", action, employeeId }));
    return json({ ok: true, employee_id: employeeId, profile_retained: true });
  }

  const name = cleanText(input.name, 160);
  const email = cleanText(input.email, 255).toLowerCase();
  const password = String(input.password || "");
  const role = cleanText(input.role, 30);
  const centerId = cleanText(input.center_id, 60).toUpperCase();
  const status = input.status === "Inactive" ? "Inactive" : "Active";
  // Three states: true and false force the device lock either way, anything else
  // (including an omitted field) means "follow the role policy". A Kiosk station
  // is shared hardware, so it can never be forced on.
  const deviceLockRequired = role === "Kiosk"
    ? (input.device_lock_required === false ? false : null)
    : (typeof input.device_lock_required === "boolean" ? input.device_lock_required : null);

  // Per-employee capability overrides. true/false force the capability either
  // way; anything else — including an omitted key — means "follow the role" and
  // is stored as the absence of a row. The catalogue is intentionally duplicated
  // from the client rather than trusted from the request: a browser must not be
  // able to invent a capability name and have it persisted.
  const KNOWN_CAPABILITIES = [
    "attendance.self", "request.submit", "directory.read",
    "team.read", "team.read_all", "attendance.review", "attendance.review.override",
    "attendance.export", "attendance.lock_period", "attendance.reopen_period",
    "schedule.manage", "schedule.override", "kiosk.manage", "employee.manage",
    "settings.manage", "capability.manage", "audit.view",
  ];
  const requestedOverrides = input.capability_overrides;
  const capabilityOverrides = new Map<string, boolean>();
  if (requestedOverrides && typeof requestedOverrides === "object" && !Array.isArray(requestedOverrides)) {
    for (const [capability, value] of Object.entries(requestedOverrides as Record<string, unknown>)) {
      if (KNOWN_CAPABILITIES.includes(capability) && typeof value === "boolean") {
        capabilityOverrides.set(capability, value);
      }
    }
  }
  const overridesSupplied = requestedOverrides !== undefined;
  const directManagerId = cleanText(input.direct_manager_id, 40).toUpperCase() || null;
  const allowedLocations = cleanList(input.allowed_locations);
  const managedLocations = cleanList(input.managed_locations);
  const annualLeaveBalanceRaw = Number(input.annual_leave_balance ?? DEFAULT_ANNUAL_LEAVE_DAYS);
  const annualLeaveBalance = Number.isFinite(annualLeaveBalanceRaw)
    ? Math.min(MAX_ANNUAL_LEAVE_DAYS, Math.max(0, annualLeaveBalanceRaw))
    : DEFAULT_ANNUAL_LEAVE_DAYS;
  const attendancePolicyId = cleanText(input.attendance_policy_id, 80) || null;

  if (!name) return failure("MISSING_NAME", "Vui lòng nhập họ tên nhân viên.", 400, { action, employeeId });
  if (!emailPattern.test(email)) return failure("INVALID_EMAIL", "Email đăng nhập không đúng định dạng.", 400, { action, employeeId });
  if (!roles.has(role)) return failure("INVALID_ROLE", "Vai trò nhân viên không hợp lệ.", 400, { action, employeeId });
  if (!centerId) return failure("MISSING_CENTER", "Vui lòng chọn địa điểm chính.", 400, { action, employeeId });
  if (directManagerId === employeeId) {
    return json({ ok: false, error: "Nhân viên không thể là quản lý trực tiếp của chính mình." }, 400);
  }
  if (role !== "Kiosk" && !attendancePolicyId) {
    return failure("MISSING_ATTENDANCE_POLICY", "Vui lòng chọn chính sách chấm công cho nhân viên.", 400, { action, employeeId });
  }
  if (action === "create" && password.length < MIN_PASSWORD_LENGTH) {
    return failure("PASSWORD_TOO_SHORT", `Mật khẩu tạm phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`, 400, { action, employeeId });
  }
  if (action === "invite" && status !== "Active") {
    return failure("INVITE_INACTIVE_FORBIDDEN", "Chỉ có thể gửi lời mời cho tài khoản đang hoạt động.", 400, { action, employeeId });
  }

  const locationIds = [...new Set([centerId, ...allowedLocations, ...managedLocations])];
  const { data: validLocations, error: locationError } = await admin
    .from("locations")
    .select("center_id")
    .eq("organization_id", organizationId)
    .in("center_id", locationIds);
  if (locationError) return failure("LOCATION_CHECK_FAILED", "Không kiểm tra được danh sách địa điểm.", 500, { action, employeeId });
  const validLocationIds = new Set((validLocations || []).map((location) => location.center_id));
  const invalidLocationId = locationIds.find((locationId) => !validLocationIds.has(locationId));
  if (invalidLocationId) {
    return failure("INVALID_LOCATION", `Địa điểm ${invalidLocationId} không tồn tại trong tổ chức.`, 400, { action, employeeId });
  }

  if (directManagerId) {
    const { data: manager, error: managerError } = await admin
      .from("employees")
      .select("employee_id,role,status")
      .eq("employee_id", directManagerId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (managerError) return failure("MANAGER_CHECK_FAILED", "Không kiểm tra được quản lý trực tiếp.", 500, { action, employeeId });
    if (!manager || manager.status !== "Active" || !managementRoles.has(manager.role)) {
      return failure("INVALID_MANAGER", "Quản lý trực tiếp không tồn tại, đã khóa hoặc không có vai trò quản lý.", 400, { action, employeeId });
    }
  }

  if (attendancePolicyId) {
    const { data: activePolicy, error: policyError } = await admin
      .from("attendance_policies")
      .select("id")
      .eq("id", attendancePolicyId)
      .eq("organization_id", organizationId)
      .eq("active", true)
      .maybeSingle();
    if (policyError) return failure("POLICY_CHECK_FAILED", "Không kiểm tra được chính sách chấm công.", 500, { action, employeeId });
    if (!activePolicy) return json({ ok: false, error: "Chính sách chấm công không hợp lệ." }, 400);
  }

  // Auth emails are globally unique in one Supabase project, so keep this check global.
  const { data: duplicateEmail, error: duplicateEmailError } = await admin
    .from("employees")
    .select("employee_id")
    .eq("email", email)
    .neq("employee_id", employeeId)
    .maybeSingle();
  if (duplicateEmailError) return failure("EMAIL_CHECK_FAILED", "Không kiểm tra được email đăng nhập.", 500, { action, employeeId });
  if (duplicateEmail) return failure("EMAIL_ALREADY_USED", "Email đăng nhập đã được gán cho nhân viên khác.", 409, { action, employeeId });

  const profile: Record<string, unknown> = {
    employee_id: employeeId,
    organization_id: organizationId,
    name,
    email,
    phone: cleanText(input.phone, 40) || null,
    role,
    center_id: centerId,
    allowed_locations: allowedLocations,
    managed_locations: managedLocations,
    direct_manager_id: directManagerId,
    annual_leave_balance: annualLeaveBalance,
    attendance_policy_id: role === "Kiosk" ? null : attendancePolicyId,
    device_lock_required: deviceLockRequired,
    position: cleanText(input.position, 120) || null,
    department: cleanText(input.department, 120) || null,
    status,
    updated_at: new Date().toISOString(),
  };

  // An admin-issued password is the name-derived default, which anyone who
  // knows the convention can guess, so the owner is prompted to replace it.
  // A profile-only update leaves the column out entirely rather than clearing a
  // reminder that is still owed. Invites are excluded: the recipient chooses
  // their own password through the Auth email, so nothing needs replacing.
  if (action !== "invite" && (action === "create" || password)) {
    profile.password_change_required = true;
  }

  if (action === "create" || action === "invite") {
    const { data: duplicateEmployee, error: duplicateEmployeeError } = await admin
      .from("employees")
      .select("employee_id")
      .eq("employee_id", employeeId)
      .maybeSingle();
    if (duplicateEmployeeError) return failure("EMPLOYEE_CHECK_FAILED", "Không kiểm tra được mã nhân viên.", 500, { action, employeeId });
    if (duplicateEmployee) return failure("EMPLOYEE_ALREADY_EXISTS", "Mã nhân viên đã tồn tại.", 409, { action, employeeId });

    const inviteRedirect = action === "invite" ? configuredAuthRedirect("AUTH_INVITE_REDIRECT_URL") : undefined;
    const { data: created, error: createError } = action === "invite"
      ? await admin.auth.admin.inviteUserByEmail(email, {
        data: { name },
        ...(inviteRedirect ? { redirectTo: inviteRedirect } : {}),
      })
      : await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
        app_metadata: { app_role: role, organization_id: organizationId },
      });
    if (createError || !created.user) {
      const authMessage = createError?.code === "email_exists" || createError?.message?.toLowerCase().includes("already")
        ? "Email đăng nhập đã tồn tại trong Supabase Auth."
        : createError?.message || (action === "invite" ? "Không gửi được lời mời tài khoản." : "Không tạo được tài khoản Auth.");
      return failure(action === "invite" ? "AUTH_INVITE_FAILED" : "AUTH_CREATE_FAILED", authMessage, 400, {
        action,
        employeeId,
        authCode: createError?.code,
      });
    }

    if (action === "invite") {
      const { error: metadataError } = await admin.auth.admin.updateUserById(created.user.id, {
        app_metadata: { app_role: role, organization_id: organizationId },
      });
      if (metadataError) {
        const { error: rollbackError } = await admin.auth.admin.deleteUser(created.user.id);
        console.error("[admin-users]", JSON.stringify({
          code: "AUTH_INVITE_METADATA_FAILED",
          employeeId,
          authCode: metadataError.code,
          rollbackCode: rollbackError?.code,
        }));
        return json({
          ok: false,
          code: rollbackError ? "AUTH_INVITE_PARTIAL" : "AUTH_INVITE_METADATA_FAILED",
          error: rollbackError
            ? "Lời mời đã tạo nhưng không thể gắn tenant và hoàn tác tài khoản. Cần đối soát Auth trước khi thử lại."
            : "Không gắn được tenant cho tài khoản được mời; lời mời đã được vô hiệu hóa.",
          commit_state: rollbackError ? "AUTH_INVITED_METADATA_PENDING" : "ROLLED_BACK",
          retryable: !rollbackError,
        }, 500);
      }
    }

    const { error: insertError } = await admin.from("employees").insert({
      ...profile,
      auth_user_id: created.user.id,
    });
    if (insertError) {
      const { error: rollbackError } = await admin.auth.admin.deleteUser(created.user.id);
      if (rollbackError) {
        console.error("[admin-users]", JSON.stringify({
          code: "EMPLOYEE_CREATE_PARTIAL",
          employeeId,
          databaseCode: insertError.code,
          rollbackCode: rollbackError.code,
        }));
        return json({
          ok: false,
          code: "EMPLOYEE_CREATE_PARTIAL",
          error: "Tài khoản Auth đã được tạo nhưng hồ sơ nhân viên chưa lưu và hoàn tác tự động thất bại. Hãy tải lại rồi nhập lại cùng file; nếu lỗi còn lặp lại, cần đối soát Auth trước khi đổi email.",
          commit_state: "AUTH_CREATED_PROFILE_PENDING",
          retryable: true,
        }, 500);
      }
      return json({
        ok: false,
        code: "EMPLOYEE_INSERT_FAILED",
        error: "Không lưu được hồ sơ nhân viên; tài khoản Auth vừa tạo đã được hoàn tác.",
        commit_state: "ROLLED_BACK",
        retryable: true,
      }, 400);
    }
    if (status === "Inactive") {
      const { error: banCreatedUserError } = await admin.auth.admin.updateUserById(created.user.id, {
        ban_duration: ACCOUNT_BAN_DURATION,
      });
      if (banCreatedUserError) {
        console.error("[admin-users]", JSON.stringify({
          code: "EMPLOYEE_CREATE_PARTIAL",
          employeeId,
          commitState: "PROFILE_CREATED_AUTH_STATUS_PENDING",
          authCode: banCreatedUserError.code,
        }));
        return json({
          ok: false,
          code: "EMPLOYEE_CREATE_PARTIAL",
          error: "Hồ sơ và tài khoản đã tạo nhưng trạng thái khóa Auth chưa đồng bộ. Hãy tải lại rồi nhập lại cùng file để hoàn tất.",
          commit_state: "PROFILE_CREATED_AUTH_STATUS_PENDING",
          retryable: true,
        }, 500);
      }
    }
    if (overridesSupplied && capabilityOverrides.size) {
      const overrideError = await applyCapabilityOverrides(
        admin, organizationId, employeeId, capabilityOverrides, KNOWN_CAPABILITIES, { clearExisting: false });
      if (overrideError) {
        return json({
          ok: false,
          code: "CAPABILITY_OVERRIDE_FAILED",
          error: "Tài khoản đã tạo nhưng chưa lưu được quyền riêng. Hãy mở lại hồ sơ và đặt lại phần phân quyền.",
          commit_state: "PROFILE_CREATED_CAPABILITIES_PENDING",
          retryable: true,
        }, 500);
      }
    }
    const { error: auditError } = await admin.from("audit_logs").insert({
      actor_employee_id: operator.employee_id,
      target_employee_id: employeeId,
      action: action === "invite" ? "EMPLOYEE_INVITED" : "EMPLOYEE_CREATED",
      entity_type: "employee",
      entity_id: employeeId,
      reason: action === "invite" ? "Admin gửi lời mời kích hoạt tài khoản" : "Tạo tài khoản quản trị",
      metadata: {
        role,
        status,
        center_id: centerId,
        organization_id: organizationId,
        ...(action === "invite" ? { delivery: "supabase_auth_email" } : {}),
      },
    });
    if (auditError) {
      console.error("[admin-users]", JSON.stringify({
        code: action === "invite" ? "INVITE_AUDIT_FAILED" : "CREATE_AUDIT_FAILED",
        employeeId,
        databaseCode: auditError.code,
      }));
      if (action === "invite") {
        return json({
          ok: false,
          code: "INVITE_AUDIT_FAILED",
          error: "Lời mời đã gửi và hồ sơ đã tạo nhưng nhật ký kiểm toán chưa được ghi nhận.",
          commit_state: "INVITED_AUDIT_PENDING",
          retryable: false,
        }, 500);
      }
    }
    return json({
      ok: true,
      employee_id: employeeId,
      actual_action: action,
      ...(action === "invite" ? { delivery: "email" } : {}),
    });
  }

  const { data: existing, error: existingError } = await admin
    .from("employees")
    .select("employee_id,auth_user_id,organization_id")
    .eq("employee_id", employeeId)
    .eq("organization_id", organizationId)
    .single();
  if (existingError || !existing) return json({ ok: false, error: "Không tìm thấy nhân viên trong tổ chức hiện tại." }, 404);

  if (operator.employee_id === employeeId && (role !== "Admin" || status !== "Active")) {
    return json({ ok: false, error: "Không thể tự hạ quyền hoặc khóa tài khoản Admin đang đăng nhập." }, 400);
  }

  let createdAuthUserId: string | null = null;
  if (existing.auth_user_id) {
    const authUpdate: Record<string, unknown> = {
      email,
      email_confirm: true,
      user_metadata: { name },
      app_metadata: { app_role: role, organization_id: organizationId },
      ban_duration: status === "Inactive" ? ACCOUNT_BAN_DURATION : "none",
    };
    if (password) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        return failure("PASSWORD_TOO_SHORT", `Mật khẩu mới phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`, 400, { action, employeeId });
      }
      authUpdate.password = password;
    }
    const { error: updateAuthError } = await admin.auth.admin.updateUserById(existing.auth_user_id, authUpdate);
    if (updateAuthError) return failure("AUTH_UPDATE_FAILED", updateAuthError.message, 400, { action, employeeId, authCode: updateAuthError.code });
  } else if (password) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return failure("PASSWORD_TOO_SHORT", `Mật khẩu tạm phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`, 400, { action, employeeId });
    }
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
      app_metadata: { app_role: role, organization_id: organizationId },
    });
    if (createError || !created.user) {
      const authMessage = createError?.code === "email_exists" || createError?.message?.toLowerCase().includes("already")
        ? "Email đăng nhập đã tồn tại trong Supabase Auth."
        : createError?.message || "Không tạo được tài khoản Auth.";
      return failure("AUTH_CREATE_FAILED", authMessage, 400, { action, employeeId, authCode: createError?.code });
    }
    existing.auth_user_id = created.user.id;
    createdAuthUserId = created.user.id;
    if (status === "Inactive") {
      await admin.auth.admin.updateUserById(created.user.id, { ban_duration: ACCOUNT_BAN_DURATION });
    }
  } else if (status === "Active") {
    return failure("PASSWORD_REQUIRED_FOR_REACTIVATION", `Hồ sơ này chưa có tài khoản đăng nhập. Hãy đặt mật khẩu tạm từ ${MIN_PASSWORD_LENGTH} ký tự để kích hoạt lại.`, 400, { action, employeeId });
  }

  if (input.reset_trusted_device === true) {
    const resetReason = cleanText(input.reset_device_reason, 500);
    if (resetReason.length < 3) {
      return json({ ok: false, error: "Vui lòng nhập lý do đặt lại thiết bị." }, 400);
    }
    const { data: resetData, error: resetError } = await admin.rpc("reset_trusted_device_v1", {
      p_employee_id: employeeId,
      p_actor_employee_id: operator.employee_id,
      p_reason: resetReason,
    });
    if (resetError || !successfulRpc(resetData)) {
      return failure("TRUSTED_DEVICE_RESET_FAILED", "Không thể đặt lại thiết bị lúc này.", 500, {
        action,
        employeeId,
        databaseCode: resetError?.code,
      });
    }
    profile.trusted_device_id = null;
    profile.trusted_device_bound_at = null;
  }

  const { error: updateError } = await admin
    .from("employees")
    .update({ ...profile, auth_user_id: existing.auth_user_id })
    .eq("employee_id", employeeId)
    .eq("organization_id", organizationId);
  if (updateError) {
    let commitState = "AUTH_UPDATED_PROFILE_PENDING";
    if (createdAuthUserId) {
      const { error: rollbackError } = await admin.auth.admin.deleteUser(createdAuthUserId);
      commitState = rollbackError ? "AUTH_CREATED_PROFILE_PENDING" : "ROLLED_BACK";
      if (rollbackError) {
        console.error("[admin-users]", JSON.stringify({
          code: "EMPLOYEE_UPDATE_ROLLBACK_FAILED",
          employeeId,
          databaseCode: updateError.code,
          rollbackCode: rollbackError.code,
        }));
      }
    }
    console.error("[admin-users]", JSON.stringify({
      code: "EMPLOYEE_UPDATE_FAILED",
      employeeId,
      databaseCode: updateError.code,
      commitState,
    }));
    return json({
      ok: false,
      code: "EMPLOYEE_UPDATE_FAILED",
      error: commitState === "ROLLED_BACK"
        ? "Không cập nhật được hồ sơ; tài khoản Auth vừa tạo đã được hoàn tác."
        : "Phần tài khoản Auth có thể đã cập nhật nhưng hồ sơ nhân viên chưa lưu. Hãy tải lại rồi nhập lại cùng file để đối soát.",
      commit_state: commitState,
      retryable: true,
    }, 500);
  }

  if (overridesSupplied) {
    const overrideError = await applyCapabilityOverrides(
      admin, organizationId, employeeId, capabilityOverrides, KNOWN_CAPABILITIES, { clearExisting: true });
    if (overrideError) {
      return json({
        ok: false,
        code: "CAPABILITY_OVERRIDE_FAILED",
        error: "Hồ sơ đã lưu nhưng chưa lưu được quyền riêng. Hãy mở lại hồ sơ và đặt lại phần phân quyền.",
        commit_state: "PROFILE_UPDATED_CAPABILITIES_PENDING",
        retryable: true,
      }, 500);
    }
  }

  await admin.from("audit_logs").insert({
    actor_employee_id: operator.employee_id,
    target_employee_id: employeeId,
    action: "EMPLOYEE_UPDATED",
    entity_type: "employee",
    entity_id: employeeId,
    reason: status === "Inactive" ? "Vô hiệu hóa tài khoản" : "Cập nhật hồ sơ tài khoản",
    metadata: { role, status, center_id: centerId, organization_id: organizationId },
  });

  return json({ ok: true, employee_id: employeeId, actual_action: action });
});
