export interface Product {
  id: string;
  name: string;
  price: number;
  description: string;
}

const PRODUCTS: Product[] = [
  {
    id: 'trail-runner',
    name: 'Trail Runner',
    price: 129,
    description: 'Lightweight shoe for technical terrain.',
  },
  {
    id: 'city-commuter',
    name: 'City Commuter',
    price: 99,
    description: 'Everyday sneaker with a recycled upper.',
  },
  { id: 'summit-boot', name: 'Summit Boot', price: 189, description: 'Waterproof boot for alpine days.' },
];

/** Stand-in for a database or commerce API call. */
export async function listProducts(): Promise<Product[]> {
  return PRODUCTS;
}

export async function getProduct(id: string): Promise<Product | null> {
  return PRODUCTS.find((p) => p.id === id) ?? null;
}
