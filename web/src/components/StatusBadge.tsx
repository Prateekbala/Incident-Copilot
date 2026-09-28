export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="muted">—</span>;
  return <span className={`status ${status}`}>{status.replace(/_/g, " ")}</span>;
}
