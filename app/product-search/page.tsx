import { ProductSearch } from "@/components/product-search";
export default function Page() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-3xl font-bold">DeepSleep product search</h1>
      <ProductSearch />
    </main>
  );
}
