import { useCallback, useEffect, useMemo, useState } from "react";
import { adminClient, inviteCleaner, setHourlyRate } from "../lib/admin";
import { startCheckout } from "../lib/billing";
import { formatDay, formatMoney, formatTime, hoursBetween } from "../lib/format";
import { supabase } from "../lib/supabase";

type Company = {
  id: string;
  name: string;
  plan: string;
  stripe_customer_id: string | null;
};

type Client = {
  id: string;
  company_id: string;
  full_name: string;
  phone: string | null;
  address: string;
  notes: string | null;
  created_at: string;
};

type StaffMember = {
  id: string;
  company_id: string;
  full_name: string;
  role: "owner" | "manager" | "cleaner";
  hourly_rate_cents: number;
};

type Shift = {
  id: string;
  company_id: string;
  client_id: string;
  staff_id: string | null;
  starts_at: string;
  ends_at: string;
  status: "planned" | "done" | "cancelled" | "no_show";
  price_cents: number;
  notes: string | null;
};

type Invoice = {
  id: string;
  company_id: string;
  client_id: string;
  number: string;
  amount_cents: number;
  due_on: string;
  paid_at: string | null;
};

type Tab = "week" | "clients" | "staff" | "invoices" | "billing" | "settings";

type ShiftDraft = {
  clientId: string;
  staffId: string;
  day: string;
  startTime: string;
  endTime: string;
  priceCents: number;
  notes: string;
};

type ClientDraft = {
  fullName: string;
  phone: string;
  address: string;
  notes: string;
};

const TABS: { id: Tab; label: string }[] = [
  { id: "week", label: "This week" },
  { id: "clients", label: "Clients" },
  { id: "staff", label: "Team" },
  { id: "invoices", label: "Invoices" },
  { id: "billing", label: "Plan" },
  { id: "settings", label: "Settings" },
];

const STATUS_LABELS: Record<Shift["status"], string> = {
  planned: "Planned",
  done: "Done",
  cancelled: "Cancelled",
  no_show: "No show",
};

const STATUS_COLORS: Record<Shift["status"], string> = {
  planned: "#2563eb",
  done: "#16a34a",
  cancelled: "#9ca3af",
  no_show: "#dc2626",
};

const PLANS = [
  { id: "free", name: "Free", price: 0, priceId: "", limit: 25 },
  { id: "team", name: "Team", price: 2900, priceId: "price_team_monthly", limit: 250 },
  { id: "pro", name: "Pro", price: 7900, priceId: "price_pro_monthly", limit: 5000 },
];

const EMPTY_SHIFT: ShiftDraft = {
  clientId: "",
  staffId: "",
  day: "",
  startTime: "09:00",
  endTime: "12:00",
  priceCents: 9000,
  notes: "",
};

const EMPTY_CLIENT: ClientDraft = {
  fullName: "",
  phone: "",
  address: "",
  notes: "",
};

const PAGE_SIZE = 25;
const DAY_MS = 86_400_000;

function startOfWeek(date: Date) {
  const copy = new Date(date);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function toDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function combine(day: string, time: string) {
  return new Date(`${day}T${time}:00`).toISOString();
}

function nextInvoiceNumber(invoices: Invoice[]) {
  const numbers = invoices.map((invoice) => Number(invoice.number.replace(/\D/g, ""))).filter((n) => !Number.isNaN(n));
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  return `INV-${String(next).padStart(4, "0")}`;
}

function csvEscape(value: string | number | null) {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function Dashboard() {
  const [tab, setTab] = useState<Tab>("week");
  const [company, setCompany] = useState<Company>(null);
  const [me, setMe] = useState<StaffMember>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>(null);
  const [notice, setNotice] = useState<string>(null);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [shiftDraft, setShiftDraft] = useState<ShiftDraft>(EMPTY_SHIFT);
  const [editingShiftId, setEditingShiftId] = useState<string>(null);
  const [isShiftModalOpen, setShiftModalOpen] = useState(false);
  const [clientDraft, setClientDraft] = useState<ClientDraft>(EMPTY_CLIENT);
  const [editingClientId, setEditingClientId] = useState<string>(null);
  const [isClientModalOpen, setClientModalOpen] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const [clientPage, setClientPage] = useState(0);
  const [clientSort, setClientSort] = useState<"name" | "newest">("name");
  const [staffFilter, setStaffFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<Shift["status"] | "all">("all");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [isInviting, setInviting] = useState(false);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [invoiceFilter, setInvoiceFilter] = useState<"all" | "open" | "paid" | "overdue">("all");
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<string[]>([]);
  const [companyNameDraft, setCompanyNameDraft] = useState("");
  const [isSavingSettings, setSavingSettings] = useState(false);
  const [confirmDeleteClientId, setConfirmDeleteClientId] = useState<string>(null);

  const weekEnd = useMemo(() => new Date(weekStart.getTime() + 7 * DAY_MS), [weekStart]);

  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, index) => new Date(weekStart.getTime() + index * DAY_MS));
  }, [weekStart]);

  const loadEverything = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      const { data: meRow, error: meError } = await supabase.from("staff").select("*").eq("id", userId).single();
      if (meError) throw meError;
      setMe(meRow);

      const { data: companyRow, error: companyError } = await supabase
        .from("companies")
        .select("*")
        .eq("id", meRow.company_id)
        .single();
      if (companyError) throw companyError;
      setCompany(companyRow);
      setCompanyNameDraft(companyRow.name);

      const [clientsRes, staffRes, invoicesRes] = await Promise.all([
        supabase.from("clients").select("*").eq("company_id", companyRow.id).order("full_name"),
        supabase.from("staff").select("*").eq("company_id", companyRow.id).order("full_name"),
        supabase.from("invoices").select("*").eq("company_id", companyRow.id).order("due_on", { ascending: false }),
      ]);
      if (clientsRes.error) throw clientsRes.error;
      if (staffRes.error) throw staffRes.error;
      if (invoicesRes.error) throw invoicesRes.error;
      setClients(clientsRes.data);
      setStaff(staffRes.data);
      setInvoices(invoicesRes.data);
    } catch (err) {
      setError(err.message ?? "Could not load your company");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadShifts = useCallback(async () => {
    if (!company) return;
    const { data, error: shiftsError } = await supabase
      .from("shifts")
      .select("*")
      .eq("company_id", company.id)
      .gte("starts_at", weekStart.toISOString())
      .lt("starts_at", weekEnd.toISOString())
      .order("starts_at");
    if (shiftsError) {
      setError(shiftsError.message);
      return;
    }
    setShifts(data);
  }, [company, weekStart, weekEnd]);

  useEffect(() => {
    loadEverything();
  }, [loadEverything]);

  useEffect(() => {
    loadShifts();
  }, [loadShifts]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    setClientPage(0);
  }, [clientSearch, clientSort]);

  const clientsById = useMemo(() => {
    const map: Record<string, Client> = {};
    for (const client of clients) map[client.id] = client;
    return map;
  }, [clients]);

  const staffById = useMemo(() => {
    const map: Record<string, StaffMember> = {};
    for (const member of staff) map[member.id] = member;
    return map;
  }, [staff]);

  const visibleShifts = useMemo(() => {
    return shifts.filter((shift) => {
      if (staffFilter !== "all" && shift.staff_id !== staffFilter) return false;
      if (statusFilter !== "all" && shift.status !== statusFilter) return false;
      return true;
    });
  }, [shifts, staffFilter, statusFilter]);

  const shiftsByDay = useMemo(() => {
    const map: Record<string, Shift[]> = {};
    for (const day of days) map[toDayKey(day)] = [];
    for (const shift of visibleShifts) {
      const key = shift.starts_at.slice(0, 10);
      if (map[key]) map[key].push(shift);
    }
    return map;
  }, [days, visibleShifts]);

  const weekTotals = useMemo(() => {
    let hours = 0;
    let revenue = 0;
    let wages = 0;
    let done = 0;
    let noShows = 0;
    for (const shift of shifts) {
      if (shift.status === "cancelled") continue;
      const length = hoursBetween(shift.starts_at, shift.ends_at);
      hours += length;
      revenue += shift.price_cents;
      const member = staffById[shift.staff_id];
      if (member) wages += Math.round(member.hourly_rate_cents * length);
      if (shift.status === "done") done += 1;
      if (shift.status === "no_show") noShows += 1;
    }
    return { hours, revenue, wages, margin: revenue - wages, done, noShows, count: shifts.length };
  }, [shifts, staffById]);

  const hoursByStaff = useMemo(() => {
    const map: Record<string, number> = {};
    for (const shift of shifts) {
      if (!shift.staff_id || shift.status === "cancelled") continue;
      map[shift.staff_id] = (map[shift.staff_id] ?? 0) + hoursBetween(shift.starts_at, shift.ends_at);
    }
    return map;
  }, [shifts]);

  const filteredClients = useMemo(() => {
    const query = clientSearch.trim().toLowerCase();
    const matching = clients.filter((client) => {
      if (!query) return true;
      return (
        client.full_name.toLowerCase().includes(query) ||
        client.address.toLowerCase().includes(query) ||
        (client.phone ?? "").includes(query)
      );
    });
    const sorted = [...matching];
    if (clientSort === "name") sorted.sort((a, b) => a.full_name.localeCompare(b.full_name));
    if (clientSort === "newest") sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return sorted;
  }, [clients, clientSearch, clientSort]);

  const pagedClients = useMemo(() => {
    return filteredClients.slice(clientPage * PAGE_SIZE, clientPage * PAGE_SIZE + PAGE_SIZE);
  }, [filteredClients, clientPage]);

  const pageCount = Math.max(1, Math.ceil(filteredClients.length / PAGE_SIZE));

  const visibleInvoices = useMemo(() => {
    const today = toDayKey(new Date());
    return invoices.filter((invoice) => {
      if (invoiceFilter === "open") return !invoice.paid_at;
      if (invoiceFilter === "paid") return Boolean(invoice.paid_at);
      if (invoiceFilter === "overdue") return !invoice.paid_at && invoice.due_on < today;
      return true;
    });
  }, [invoices, invoiceFilter]);

  const invoiceTotals = useMemo(() => {
    const today = toDayKey(new Date());
    let open = 0;
    let overdue = 0;
    let paid = 0;
    for (const invoice of invoices) {
      if (invoice.paid_at) paid += invoice.amount_cents;
      else if (invoice.due_on < today) overdue += invoice.amount_cents;
      else open += invoice.amount_cents;
    }
    return { open, overdue, paid };
  }, [invoices]);

  const currentPlan = PLANS.find((plan) => plan.id === company?.plan) ?? PLANS[0];
  const isOverClientLimit = clients.length >= currentPlan.limit;
  const canManage = me?.role === "owner" || me?.role === "manager";

  function openNewShift(day?: Date) {
    setEditingShiftId(null);
    setShiftDraft({ ...EMPTY_SHIFT, day: toDayKey(day ?? new Date()) });
    setShiftModalOpen(true);
  }

  function openEditShift(shift: Shift) {
    setEditingShiftId(shift.id);
    setShiftDraft({
      clientId: shift.client_id,
      staffId: shift.staff_id ?? "",
      day: shift.starts_at.slice(0, 10),
      startTime: shift.starts_at.slice(11, 16),
      endTime: shift.ends_at.slice(11, 16),
      priceCents: shift.price_cents,
      notes: shift.notes ?? "",
    });
    setShiftModalOpen(true);
  }

  async function saveShift() {
    if (!shiftDraft.clientId || !shiftDraft.day) {
      setError("Pick a client and a day");
      return;
    }
    const payload = {
      company_id: company.id,
      client_id: shiftDraft.clientId,
      staff_id: shiftDraft.staffId || null,
      starts_at: combine(shiftDraft.day, shiftDraft.startTime),
      ends_at: combine(shiftDraft.day, shiftDraft.endTime),
      price_cents: shiftDraft.priceCents,
      notes: shiftDraft.notes || null,
    };
    if (payload.ends_at <= payload.starts_at) {
      setError("A shift has to end after it starts");
      return;
    }
    const clash = shifts.find((shift) => {
      if (shift.id === editingShiftId || !payload.staff_id || shift.staff_id !== payload.staff_id) return false;
      return shift.starts_at < payload.ends_at && shift.ends_at > payload.starts_at && shift.status !== "cancelled";
    });
    if (clash) {
      const member = staffById[payload.staff_id];
      setError(`${member?.full_name ?? "This cleaner"} already has a shift at ${formatTime(clash.starts_at)}`);
      return;
    }
    const request = editingShiftId
      ? supabase.from("shifts").update(payload).eq("id", editingShiftId)
      : supabase.from("shifts").insert(payload);
    const { error: saveError } = await request;
    if (saveError) {
      setError(saveError.message);
      return;
    }
    setShiftModalOpen(false);
    setNotice(editingShiftId ? "Shift updated" : "Shift added");
    loadShifts();
  }

  async function setShiftStatus(shift: Shift, status: Shift["status"]) {
    const previous = shifts;
    setShifts((list) => list.map((item) => (item.id === shift.id ? { ...item, status } : item)));
    const { error: statusError } = await supabase.from("shifts").update({ status }).eq("id", shift.id);
    if (statusError) {
      setShifts(previous);
      setError(statusError.message);
    }
  }

  async function deleteShift(shiftId: string) {
    const { error: deleteError } = await supabase.from("shifts").delete().eq("id", shiftId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setShifts((list) => list.filter((shift) => shift.id !== shiftId));
    setShiftModalOpen(false);
    setNotice("Shift removed");
  }

  async function copyLastWeek() {
    const lastWeekStart = new Date(weekStart.getTime() - 7 * DAY_MS);
    const { data, error: copyError } = await supabase
      .from("shifts")
      .select("*")
      .eq("company_id", company.id)
      .gte("starts_at", lastWeekStart.toISOString())
      .lt("starts_at", weekStart.toISOString());
    if (copyError) {
      setError(copyError.message);
      return;
    }
    const copies = data
      .filter((shift) => shift.status !== "cancelled")
      .map((shift) => ({
        company_id: shift.company_id,
        client_id: shift.client_id,
        staff_id: shift.staff_id,
        starts_at: new Date(new Date(shift.starts_at).getTime() + 7 * DAY_MS).toISOString(),
        ends_at: new Date(new Date(shift.ends_at).getTime() + 7 * DAY_MS).toISOString(),
        price_cents: shift.price_cents,
        notes: shift.notes,
      }));
    if (copies.length === 0) {
      setNotice("Nothing to copy from last week");
      return;
    }
    const { error: insertError } = await supabase.from("shifts").insert(copies);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setNotice(`Copied ${copies.length} shifts from last week`);
    loadShifts();
  }

  function openNewClient() {
    if (isOverClientLimit) {
      setError(`Your ${currentPlan.name} plan allows ${currentPlan.limit} clients. Upgrade to add more.`);
      setTab("billing");
      return;
    }
    setEditingClientId(null);
    setClientDraft(EMPTY_CLIENT);
    setClientModalOpen(true);
  }

  function openEditClient(client: Client) {
    setEditingClientId(client.id);
    setClientDraft({
      fullName: client.full_name,
      phone: client.phone ?? "",
      address: client.address,
      notes: client.notes ?? "",
    });
    setClientModalOpen(true);
  }

  async function saveClient() {
    if (!clientDraft.fullName.trim() || !clientDraft.address.trim()) {
      setError("A client needs a name and an address");
      return;
    }
    const payload = {
      company_id: company.id,
      full_name: clientDraft.fullName.trim(),
      phone: clientDraft.phone.trim() || null,
      address: clientDraft.address.trim(),
      notes: clientDraft.notes.trim() || null,
    };
    if (editingClientId) {
      const { data, error: updateError } = await supabase
        .from("clients")
        .update(payload)
        .eq("id", editingClientId)
        .select()
        .single();
      if (updateError) {
        setError(updateError.message);
        return;
      }
      setClients((list) => list.map((client) => (client.id === editingClientId ? data : client)));
      setNotice("Client saved");
    } else {
      const { data, error: insertError } = await supabase.from("clients").insert(payload).select().single();
      if (insertError) {
        setError(insertError.message);
        return;
      }
      setClients((list) => [...list, data]);
      setNotice("Client added");
    }
    setClientModalOpen(false);
  }

  async function deleteClient(clientId: string) {
    const upcoming = shifts.some((shift) => shift.client_id === clientId && shift.status === "planned");
    if (upcoming) {
      setError("This client has planned shifts. Cancel them first.");
      setConfirmDeleteClientId(null);
      return;
    }
    const { error: deleteError } = await supabase.from("clients").delete().eq("id", clientId);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setClients((list) => list.filter((client) => client.id !== clientId));
    setConfirmDeleteClientId(null);
    setNotice("Client removed");
  }

  function exportClients() {
    const rows = [["Name", "Phone", "Address", "Notes", "Added"]];
    for (const client of filteredClients) {
      rows.push([client.full_name, client.phone, client.address, client.notes, client.created_at.slice(0, 10)]);
    }
    downloadCsv(`clients-${toDayKey(new Date())}.csv`, rows);
  }

  function exportWeek() {
    const rows: (string | number | null)[][] = [["Day", "Start", "End", "Client", "Cleaner", "Status", "Price"]];
    for (const shift of shifts) {
      rows.push([
        formatDay(shift.starts_at),
        formatTime(shift.starts_at),
        formatTime(shift.ends_at),
        clientsById[shift.client_id]?.full_name ?? "",
        staffById[shift.staff_id]?.full_name ?? "Unassigned",
        STATUS_LABELS[shift.status],
        (shift.price_cents / 100).toFixed(2),
      ]);
    }
    downloadCsv(`week-${toDayKey(weekStart)}.csv`, rows);
  }

  async function sendInvite() {
    if (!inviteEmail.includes("@") || !inviteName.trim()) {
      setError("Enter a name and an email address");
      return;
    }
    setInviting(true);
    try {
      await inviteCleaner(inviteEmail.trim(), company.id, inviteName.trim());
      setInviteEmail("");
      setInviteName("");
      setNotice("Invite sent");
      const { data } = await adminClient.from("staff").select("*").eq("company_id", company.id).order("full_name");
      if (data) setStaff(data);
    } catch (err) {
      setError(err.message ?? "Invite failed");
    } finally {
      setInviting(false);
    }
  }

  async function saveRate(member: StaffMember) {
    const raw = rateDrafts[member.id];
    const value = Math.round(Number(raw) * 100);
    if (!raw || Number.isNaN(value) || value <= 0) {
      setError("Enter an hourly rate above zero");
      return;
    }
    try {
      await setHourlyRate(member.id, value);
      setStaff((list) => list.map((item) => (item.id === member.id ? { ...item, hourly_rate_cents: value } : item)));
      setRateDrafts((drafts) => ({ ...drafts, [member.id]: "" }));
      setNotice(`Rate for ${member.full_name} saved`);
    } catch (err) {
      setError(err.message ?? "Could not save the rate");
    }
  }

  async function removeStaff(member: StaffMember) {
    if (member.role === "owner") {
      setError("The owner can't be removed");
      return;
    }
    const { error: removeError } = await adminClient.from("staff").delete().eq("id", member.id);
    if (removeError) {
      setError(removeError.message);
      return;
    }
    setStaff((list) => list.filter((item) => item.id !== member.id));
    setNotice(`${member.full_name} removed from the team`);
  }

  async function createInvoiceForClient(clientId: string) {
    const doneShifts = shifts.filter((shift) => shift.client_id === clientId && shift.status === "done");
    if (doneShifts.length === 0) {
      setError("No finished shifts this week for that client");
      return;
    }
    const amount = doneShifts.reduce((sum, shift) => sum + shift.price_cents, 0);
    const dueOn = toDayKey(new Date(Date.now() + 14 * DAY_MS));
    const { data, error: invoiceError } = await supabase
      .from("invoices")
      .insert({
        company_id: company.id,
        client_id: clientId,
        number: nextInvoiceNumber(invoices),
        amount_cents: amount,
        due_on: dueOn,
      })
      .select()
      .single();
    if (invoiceError) {
      setError(invoiceError.message);
      return;
    }
    setInvoices((list) => [data, ...list]);
    setNotice(`Invoice ${data.number} created for ${formatMoney(amount)}`);
  }

  async function markInvoicesPaid() {
    if (selectedInvoiceIds.length === 0) return;
    const paidAt = new Date().toISOString();
    const { error: paidError } = await supabase
      .from("invoices")
      .update({ paid_at: paidAt })
      .in("id", selectedInvoiceIds);
    if (paidError) {
      setError(paidError.message);
      return;
    }
    setInvoices((list) =>
      list.map((invoice) => (selectedInvoiceIds.includes(invoice.id) ? { ...invoice, paid_at: paidAt } : invoice)),
    );
    setNotice(`${selectedInvoiceIds.length} invoices marked paid`);
    setSelectedInvoiceIds([]);
  }

  function toggleInvoice(invoiceId: string) {
    setSelectedInvoiceIds((ids) =>
      ids.includes(invoiceId) ? ids.filter((id) => id !== invoiceId) : [...ids, invoiceId],
    );
  }

  async function upgrade(priceId: string) {
    try {
      await startCheckout(company.id, priceId);
    } catch (err) {
      setError(err.message ?? "Checkout did not start");
    }
  }

  async function saveSettings() {
    if (!companyNameDraft.trim()) {
      setError("Company name can't be empty");
      return;
    }
    setSavingSettings(true);
    const { error: settingsError } = await supabase
      .from("companies")
      .update({ name: companyNameDraft.trim() })
      .eq("id", company.id);
    setSavingSettings(false);
    if (settingsError) {
      setError(settingsError.message);
      return;
    }
    setCompany({ ...company, name: companyNameDraft.trim() });
    setNotice("Settings saved");
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  function renderWeek() {
    return (
      <section className="panel">
        <header className="panel-header">
          <div className="week-nav">
            <button onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS))}>Previous</button>
            <strong>
              {formatDay(weekStart.toISOString())} to {formatDay(new Date(weekEnd.getTime() - DAY_MS).toISOString())}
            </strong>
            <button onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS))}>Next</button>
            <button onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</button>
          </div>
          <div className="filters">
            <select value={staffFilter} onChange={(event) => setStaffFilter(event.target.value)}>
              <option value="all">Everyone</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.full_name}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as Shift["status"] | "all")}
            >
              <option value="all">Any status</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {canManage && <button onClick={copyLastWeek}>Copy last week</button>}
            <button onClick={exportWeek}>Export</button>
            {canManage && (
              <button className="primary" onClick={() => openNewShift()}>
                Add shift
              </button>
            )}
          </div>
        </header>

        <div className="stats">
          <div className="stat">
            <span>Shifts</span>
            <strong>{weekTotals.count}</strong>
          </div>
          <div className="stat">
            <span>Hours</span>
            <strong>{weekTotals.hours.toFixed(1)}</strong>
          </div>
          <div className="stat">
            <span>Revenue</span>
            <strong>{formatMoney(weekTotals.revenue)}</strong>
          </div>
          <div className="stat">
            <span>Wages</span>
            <strong>{formatMoney(weekTotals.wages)}</strong>
          </div>
          <div className="stat">
            <span>Margin</span>
            <strong className={weekTotals.margin < 0 ? "negative" : ""}>{formatMoney(weekTotals.margin)}</strong>
          </div>
          <div className="stat">
            <span>No shows</span>
            <strong>{weekTotals.noShows}</strong>
          </div>
        </div>

        <div className="week-grid">
          {days.map((day) => {
            const key = toDayKey(day);
            const dayShifts = shiftsByDay[key] ?? [];
            return (
              <div key={key} className="day-column">
                <div className="day-header">
                  <span>{formatDay(day.toISOString())}</span>
                  {canManage && (
                    <button className="link" onClick={() => openNewShift(day)}>
                      +
                    </button>
                  )}
                </div>
                {dayShifts.length === 0 && <p className="muted">No shifts</p>}
                {dayShifts.map((shift) => {
                  const client = clientsById[shift.client_id];
                  const member = staffById[shift.staff_id];
                  return (
                    <article
                      key={shift.id}
                      className="shift-card"
                      style={{ borderLeftColor: STATUS_COLORS[shift.status] }}
                    >
                      <div className="shift-time">
                        {formatTime(shift.starts_at)} to {formatTime(shift.ends_at)}
                      </div>
                      <div className="shift-client">{client?.full_name ?? "Unknown client"}</div>
                      <div className="shift-address muted">{client?.address}</div>
                      <div className="shift-staff">{member?.full_name ?? "Unassigned"}</div>
                      <div className="shift-price">{formatMoney(shift.price_cents)}</div>
                      {shift.notes && <div className="shift-notes muted">{shift.notes}</div>}
                      <div className="shift-actions">
                        <select
                          value={shift.status}
                          onChange={(event) => setShiftStatus(shift, event.target.value as Shift["status"])}
                        >
                          {Object.entries(STATUS_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                        {canManage && (
                          <button className="link" onClick={() => openEditShift(shift)}>
                            Edit
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  function renderClients() {
    return (
      <section className="panel">
        <header className="panel-header">
          <input
            className="search"
            placeholder="Search by name, address or phone"
            value={clientSearch}
            onChange={(event) => setClientSearch(event.target.value)}
          />
          <div className="filters">
            <select value={clientSort} onChange={(event) => setClientSort(event.target.value as "name" | "newest")}>
              <option value="name">A to Z</option>
              <option value="newest">Newest first</option>
            </select>
            <button onClick={exportClients}>Export</button>
            <button className="primary" onClick={openNewClient}>
              Add client
            </button>
          </div>
        </header>
        <p className="muted">
          {filteredClients.length} of {clients.length} clients · plan limit {currentPlan.limit}
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Address</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pagedClients.map((client) => (
              <tr key={client.id}>
                <td>{client.full_name}</td>
                <td>{client.phone ?? "—"}</td>
                <td>{client.address}</td>
                <td className="muted">{client.notes}</td>
                <td className="row-actions">
                  <button className="link" onClick={() => openEditClient(client)}>
                    Edit
                  </button>
                  {canManage && (
                    <button className="link" onClick={() => createInvoiceForClient(client.id)}>
                      Invoice
                    </button>
                  )}
                  {canManage && confirmDeleteClientId !== client.id && (
                    <button className="link danger" onClick={() => setConfirmDeleteClientId(client.id)}>
                      Delete
                    </button>
                  )}
                  {confirmDeleteClientId === client.id && (
                    <span className="confirm">
                      Sure?
                      <button className="link danger" onClick={() => deleteClient(client.id)}>
                        Yes
                      </button>
                      <button className="link" onClick={() => setConfirmDeleteClientId(null)}>
                        No
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pager">
          <button disabled={clientPage === 0} onClick={() => setClientPage(clientPage - 1)}>
            Previous
          </button>
          <span>
            Page {clientPage + 1} of {pageCount}
          </span>
          <button disabled={clientPage + 1 >= pageCount} onClick={() => setClientPage(clientPage + 1)}>
            Next
          </button>
        </div>
      </section>
    );
  }

  function renderStaff() {
    return (
      <section className="panel">
        <header className="panel-header">
          <h2>Team</h2>
        </header>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Rate</th>
              <th>Hours this week</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => (
              <tr key={member.id}>
                <td>{member.full_name}</td>
                <td>{member.role}</td>
                <td>
                  {formatMoney(member.hourly_rate_cents)}/h
                  {canManage && (
                    <span className="inline-edit">
                      <input
                        placeholder="New rate"
                        value={rateDrafts[member.id] ?? ""}
                        onChange={(event) => setRateDrafts({ ...rateDrafts, [member.id]: event.target.value })}
                      />
                      <button className="link" onClick={() => saveRate(member)}>
                        Save
                      </button>
                    </span>
                  )}
                </td>
                <td>{(hoursByStaff[member.id] ?? 0).toFixed(1)}</td>
                <td>
                  {canManage && member.role !== "owner" && (
                    <button className="link danger" onClick={() => removeStaff(member)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {canManage && (
          <div className="invite">
            <h3>Invite a cleaner</h3>
            <input placeholder="Full name" value={inviteName} onChange={(event) => setInviteName(event.target.value)} />
            <input placeholder="Email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
            <button className="primary" disabled={isInviting} onClick={sendInvite}>
              {isInviting ? "Sending…" : "Send invite"}
            </button>
          </div>
        )}
      </section>
    );
  }

  function renderInvoices() {
    return (
      <section className="panel">
        <header className="panel-header">
          <div className="stats">
            <div className="stat">
              <span>Open</span>
              <strong>{formatMoney(invoiceTotals.open)}</strong>
            </div>
            <div className="stat">
              <span>Overdue</span>
              <strong className="negative">{formatMoney(invoiceTotals.overdue)}</strong>
            </div>
            <div className="stat">
              <span>Paid</span>
              <strong>{formatMoney(invoiceTotals.paid)}</strong>
            </div>
          </div>
          <div className="filters">
            <select
              value={invoiceFilter}
              onChange={(event) => setInvoiceFilter(event.target.value as "all" | "open" | "paid" | "overdue")}
            >
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="overdue">Overdue</option>
              <option value="paid">Paid</option>
            </select>
            {canManage && (
              <button disabled={selectedInvoiceIds.length === 0} onClick={markInvoicesPaid}>
                Mark paid ({selectedInvoiceIds.length})
              </button>
            )}
          </div>
        </header>
        <table className="table">
          <thead>
            <tr>
              <th />
              <th>Number</th>
              <th>Client</th>
              <th>Amount</th>
              <th>Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {visibleInvoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <input
                    type="checkbox"
                    disabled={Boolean(invoice.paid_at)}
                    checked={selectedInvoiceIds.includes(invoice.id)}
                    onChange={() => toggleInvoice(invoice.id)}
                  />
                </td>
                <td>{invoice.number}</td>
                <td>{clientsById[invoice.client_id]?.full_name ?? "—"}</td>
                <td>{formatMoney(invoice.amount_cents)}</td>
                <td>{invoice.due_on}</td>
                <td>{invoice.paid_at ? `Paid ${invoice.paid_at.slice(0, 10)}` : "Open"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visibleInvoices.length === 0 && <p className="muted">No invoices here yet</p>}
      </section>
    );
  }

  function renderBilling() {
    return (
      <section className="panel">
        <header className="panel-header">
          <h2>Your plan: {currentPlan.name}</h2>
        </header>
        <p className="muted">
          You have {clients.length} clients. {isOverClientLimit ? "You've hit the limit of your plan." : ""}
        </p>
        <div className="plans">
          {PLANS.map((plan) => (
            <div key={plan.id} className={plan.id === currentPlan.id ? "plan current" : "plan"}>
              <h3>{plan.name}</h3>
              <p className="price">{plan.price ? `${formatMoney(plan.price)}/month` : "Free"}</p>
              <p>Up to {plan.limit} clients</p>
              {plan.id === currentPlan.id && <p className="badge">Current plan</p>}
              {plan.id !== currentPlan.id && plan.priceId && me?.role === "owner" && (
                <button className="primary" onClick={() => upgrade(plan.priceId)}>
                  Switch to {plan.name}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    );
  }

  function renderSettings() {
    return (
      <section className="panel">
        <header className="panel-header">
          <h2>Settings</h2>
        </header>
        <label className="field">
          <span>Company name</span>
          <input value={companyNameDraft} onChange={(event) => setCompanyNameDraft(event.target.value)} />
        </label>
        <label className="field">
          <span>Signed in as</span>
          <input value={me?.full_name ?? ""} disabled />
        </label>
        <div className="actions">
          <button className="primary" disabled={isSavingSettings || me?.role !== "owner"} onClick={saveSettings}>
            {isSavingSettings ? "Saving…" : "Save"}
          </button>
          <button onClick={signOut}>Sign out</button>
        </div>
      </section>
    );
  }

  function renderShiftModal() {
    if (!isShiftModalOpen) return null;
    return (
      <div className="modal-backdrop" onClick={() => setShiftModalOpen(false)}>
        <div className="modal" onClick={(event) => event.stopPropagation()}>
          <h2>{editingShiftId ? "Edit shift" : "New shift"}</h2>
          <label className="field">
            <span>Client</span>
            <select
              value={shiftDraft.clientId}
              onChange={(event) => setShiftDraft({ ...shiftDraft, clientId: event.target.value })}
            >
              <option value="">Pick a client</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.full_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Cleaner</span>
            <select
              value={shiftDraft.staffId}
              onChange={(event) => setShiftDraft({ ...shiftDraft, staffId: event.target.value })}
            >
              <option value="">Unassigned</option>
              {staff.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.full_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Day</span>
            <input
              type="date"
              value={shiftDraft.day}
              onChange={(event) => setShiftDraft({ ...shiftDraft, day: event.target.value })}
            />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Starts</span>
              <input
                type="time"
                value={shiftDraft.startTime}
                onChange={(event) => setShiftDraft({ ...shiftDraft, startTime: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Ends</span>
              <input
                type="time"
                value={shiftDraft.endTime}
                onChange={(event) => setShiftDraft({ ...shiftDraft, endTime: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>Price</span>
            <input
              type="number"
              min={0}
              step={5}
              value={shiftDraft.priceCents / 100}
              onChange={(event) =>
                setShiftDraft({ ...shiftDraft, priceCents: Math.round(Number(event.target.value) * 100) })
              }
            />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea
              value={shiftDraft.notes}
              onChange={(event) => setShiftDraft({ ...shiftDraft, notes: event.target.value })}
            />
          </label>
          <div className="actions">
            {editingShiftId && (
              <button className="danger" onClick={() => deleteShift(editingShiftId)}>
                Delete
              </button>
            )}
            <button onClick={() => setShiftModalOpen(false)}>Cancel</button>
            <button className="primary" onClick={saveShift}>
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderClientModal() {
    if (!isClientModalOpen) return null;
    return (
      <div className="modal-backdrop" onClick={() => setClientModalOpen(false)}>
        <div className="modal" onClick={(event) => event.stopPropagation()}>
          <h2>{editingClientId ? "Edit client" : "New client"}</h2>
          <label className="field">
            <span>Full name</span>
            <input
              value={clientDraft.fullName}
              onChange={(event) => setClientDraft({ ...clientDraft, fullName: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Phone</span>
            <input
              value={clientDraft.phone}
              onChange={(event) => setClientDraft({ ...clientDraft, phone: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Address</span>
            <input
              value={clientDraft.address}
              onChange={(event) => setClientDraft({ ...clientDraft, address: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea
              value={clientDraft.notes}
              onChange={(event) => setClientDraft({ ...clientDraft, notes: event.target.value })}
            />
          </label>
          <div className="actions">
            <button onClick={() => setClientModalOpen(false)}>Cancel</button>
            <button className="primary" onClick={saveClient}>
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="loading">Loading your week…</div>;
  }

  if (!company) {
    return (
      <div className="empty">
        <h1>No company yet</h1>
        <p>{error ?? "Ask the owner of your cleaning company to invite you."}</p>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Shiftboard</div>
        <div className="company">{company.name}</div>
        <nav>
          {TABS.map((item) => (
            <button
              key={item.id}
              className={item.id === tab ? "nav-item active" : "nav-item"}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="me muted">
          {me?.full_name} · {me?.role}
        </div>
      </aside>
      <main className="content">
        {error && (
          <div className="banner error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {notice && <div className="banner notice">{notice}</div>}
        {tab === "week" && renderWeek()}
        {tab === "clients" && renderClients()}
        {tab === "staff" && renderStaff()}
        {tab === "invoices" && renderInvoices()}
        {tab === "billing" && renderBilling()}
        {tab === "settings" && renderSettings()}
      </main>
      {renderShiftModal()}
      {renderClientModal()}
    </div>
  );
}

export default Dashboard;
