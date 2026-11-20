import { TableView } from "@/components/TableView";
import { TopBar } from "@/components/TopBar";

export default async function TablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    // One screen: the table scales to the space left; panels below it
    // (buy-in, cash-out) scroll if the window is short.
    <div className="flex h-dvh flex-col overflow-y-auto overflow-x-hidden">
      <TopBar />
      <TableView tableId={id} />
    </div>
  );
}
