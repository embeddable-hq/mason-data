/**
 * THE SHOP AS THE LISTENER SAW IT: a small synthetic shop's eight tables, their columns and keys and the foreign keys
 * between them, as the Postgres listener served them when the corpus was recorded (tests/postgres-api/corpus/
 * tools.ts): the recorded statements name these tables and columns.
 */
import type { PgSchema } from "../../../src/api/postgres/schema.ts";

export const SHOP_SCHEMA: PgSchema = {
  database: "shop",
  tables: [
    {
      name: "categories",
      description: "One row per category products are filed under, keyed by its code.",
      primaryKey: [
        "code"
      ],
      columns: [
        {
          name: "code",
          type: "text",
          description: "The category's code, its unique key. A product names its category by it (products.category)."
        },
        {
          name: "tenant_id",
          type: "text",
          description: "The tenant (the shop) the category belongs to."
        },
        {
          name: "name",
          type: "text",
          description: "The category's name."
        }
      ],
      joins: [
        {
          name: "products",
          table: "products",
          on: [
            "code",
            "category"
          ],
          relationship: "one_to_many"
        },
        {
          name: "tenants",
          table: "tenants",
          on: [
            "tenant_id",
            "id"
          ],
          relationship: "many_to_one"
        }
      ]
    },
    {
      name: "customers",
      description: "One row per customer: the tenant they belong to, their name and email, and when they signed up.",
      primaryKey: [
        "id"
      ],
      columns: [
        {
          name: "id",
          type: "int8",
          description: "The customer's unique id. An order names its customer by this id (customer_id)."
        },
        {
          name: "tenant_id",
          type: "text",
          description: "The tenant (the shop) the customer belongs to. Every table of the demo carries it, so a token scoped to one tenant reads only that tenant's rows."
        },
        {
          name: "name",
          type: "text",
          description: "The customer's name."
        },
        {
          name: "email",
          type: "text",
          description: "The customer's email address."
        },
        {
          name: "created_at",
          type: "timestamptz",
          description: "When the customer signed up, in UTC."
        }
      ],
      joins: [
        {
          name: "latest_orders",
          table: "latest_orders",
          on: [
            "id",
            "customer_id"
          ],
          relationship: "one_to_one"
        },
        {
          name: "latest_status",
          table: "latest_status",
          on: [
            "id",
            "customer_id"
          ],
          relationship: "one_to_one"
        },
        {
          name: "tenants",
          table: "tenants",
          on: [
            "tenant_id",
            "id"
          ],
          relationship: "many_to_one"
        },
        {
          name: "orders",
          table: "orders",
          on: [
            "id",
            "customer_id"
          ],
          relationship: "one_to_many"
        }
      ]
    },
    {
      name: "latest_orders",
      description: "One row per customer, the order they placed last, and when they placed their first.",
      primaryKey: [
        "customer_id"
      ],
      columns: [
        {
          name: "customer_id",
          type: "int8",
          description: "The customer (an id in customers)."
        },
        {
          name: "tenant_id",
          type: "text",
          description: "The tenant the latest order was placed with."
        },
        {
          name: "order_id",
          type: "text",
          description: "The latest order's id, as text; use it to look the order's notes up."
        },
        {
          name: "status",
          type: "text",
          description: "The latest order's status."
        },
        {
          name: "amount",
          type: "float8",
          description: "The latest order's amount."
        },
        {
          name: "created_at",
          type: "timestamptz",
          description: "When the latest order was placed."
        },
        {
          name: "first_order_at",
          type: "timestamptz",
          description: "When the customer's first order was placed."
        },
        {
          name: "notes",
          type: "text",
          description: "The latest order's notes (the shop's wide column — kept off every trunk, read by row id)."
        },
        {
          name: "is_paid",
          type: "bool",
          description: "Whether the latest order is paid."
        }
      ],
      joins: [
        {
          name: "customers",
          table: "customers",
          on: [
            "customer_id",
            "id"
          ],
          relationship: "one_to_one"
        },
        {
          name: "tenants",
          table: "tenants",
          on: [
            "tenant_id",
            "id"
          ],
          relationship: "many_to_one"
        }
      ]
    },
    {
      name: "latest_status",
      description: "One row per customer, the status of the order they placed last.",
      primaryKey: [
        "customer_id"
      ],
      columns: [
        {
          name: "customer_id",
          type: "int8",
          description: "The customer (an id in customers)."
        },
        {
          name: "first_order_at",
          type: "timestamptz",
          description: "When the customer's first order was placed."
        },
        {
          name: "status",
          type: "text",
          description: "The latest order's status, NULL when it has none."
        }
      ],
      joins: [
        {
          name: "customers",
          table: "customers",
          on: [
            "customer_id",
            "id"
          ],
          relationship: "one_to_one"
        }
      ]
    },
    {
      name: "order_items",
      description: "One row per line of an order: the product, the quantity and the unit price, with the line's total.",
      primaryKey: [
        "id"
      ],
      columns: [
        {
          name: "id",
          type: "int8",
          description: "The order item's unique id."
        },
        {
          name: "tenant_id",
          type: "text",
          description: "The tenant (the shop) the item was sold by."
        },
        {
          name: "order_id",
          type: "int8",
          description: "The id of the order the item belongs to (an id in orders)."
        },
        {
          name: "product",
          type: "text",
          description: "The product sold, such as 'widget' or 'gadget'."
        },
        {
          name: "quantity",
          type: "int4",
          description: "How many of the product the line sells."
        },
        {
          name: "unit_price",
          type: "float8",
          description: "The price of one unit, in the shop's currency."
        },
        {
          name: "line_total",
          type: "float8",
          description: "What the line is worth, quantity times unit price."
        }
      ],
      joins: [
        {
          name: "products",
          table: "products",
          on: [
            "product",
            "sku"
          ],
          relationship: "many_to_one"
        },
        {
          name: "orders",
          table: "orders",
          on: [
            "order_id",
            "id"
          ],
          relationship: "many_to_one"
        }
      ]
    },
    {
      name: "orders",
      description: "One row per order: its tenant and customer, its status (pending, paid or refunded), its amount and when it was placed.",
      primaryKey: [
        "id"
      ],
      columns: [
        {
          name: "id",
          type: "int8",
          description: "The order's unique id. An order item names its order by this id (order_id)."
        },
        {
          name: "notes",
          type: "text",
          description: "Free text about the order, kilobytes long on many rows (the shop's wide column — kept off every trunk, read by row id)."
        },
        {
          name: "tenant_id",
          type: "text",
          description: "The tenant (the shop) the order was placed with."
        },
        {
          name: "customer_id",
          type: "int8",
          description: "The id of the customer who placed the order (an id in customers)."
        },
        {
          name: "status",
          type: "text",
          description: "Where the order is: 'pending' until it is paid, then 'paid', or 'refunded'. An order changes status after it is placed, and the change replicates like any other."
        },
        {
          name: "amount",
          type: "float8",
          description: "What the order is worth, in the shop's currency."
        },
        {
          name: "created_at",
          type: "timestamptz",
          description: "When the order was placed, in UTC."
        }
      ],
      joins: [
        {
          name: "tenants",
          table: "tenants",
          on: [
            "tenant_id",
            "id"
          ],
          relationship: "many_to_one"
        },
        {
          name: "customers",
          table: "customers",
          on: [
            "customer_id",
            "id"
          ],
          relationship: "many_to_one"
        },
        {
          name: "order_items",
          table: "order_items",
          on: [
            "id",
            "order_id"
          ],
          relationship: "one_to_many"
        }
      ]
    },
    {
      name: "products",
      description: "One row per product a tenant sells, keyed by SKU, with the category it is filed under.",
      primaryKey: [
        "sku"
      ],
      columns: [
        {
          name: "sku",
          type: "text",
          description: "The product's stock-keeping unit, its unique key. An item names its product by it (order_items.product)."
        },
        {
          name: "tenant_id",
          type: "text",
          description: "The tenant (the shop) that sells the product."
        },
        {
          name: "name",
          type: "text",
          description: "The product's name."
        },
        {
          name: "category",
          type: "text",
          description: "The code of the category the product is filed under (categories.code), or none."
        },
        {
          name: "created_at",
          type: "timestamptz",
          description: "When the product was listed, in UTC."
        }
      ],
      joins: [
        {
          name: "order_items",
          table: "order_items",
          on: [
            "sku",
            "product"
          ],
          relationship: "one_to_many"
        },
        {
          name: "categories",
          table: "categories",
          on: [
            "category",
            "code"
          ],
          relationship: "many_to_one"
        },
        {
          name: "tenants",
          table: "tenants",
          on: [
            "tenant_id",
            "id"
          ],
          relationship: "many_to_one"
        }
      ]
    },
    {
      name: "tenants",
      description: "One row per tenant, the shop whose rows a token reads.",
      primaryKey: [
        "id"
      ],
      columns: [
        {
          name: "id",
          type: "text",
          description: "The tenant's id, the text every other table carries as tenant_id."
        },
        {
          name: "name",
          type: "text",
          description: "The shop's name."
        },
        {
          name: "plan",
          type: "text",
          description: "The plan the shop is on."
        }
      ],
      joins: [
        {
          name: "customers",
          table: "customers",
          on: [
            "id",
            "tenant_id"
          ],
          relationship: "one_to_many"
        },
        {
          name: "orders",
          table: "orders",
          on: [
            "id",
            "tenant_id"
          ],
          relationship: "one_to_many"
        },
        {
          name: "products",
          table: "products",
          on: [
            "id",
            "tenant_id"
          ],
          relationship: "one_to_many"
        },
        {
          name: "categories",
          table: "categories",
          on: [
            "id",
            "tenant_id"
          ],
          relationship: "one_to_many"
        },
        {
          name: "latest_orders",
          table: "latest_orders",
          on: [
            "id",
            "tenant_id"
          ],
          relationship: "one_to_many"
        }
      ]
    }
  ]
};
