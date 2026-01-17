# Design Shopify - Development with Claude

## Project Context

Building a multi-tenant e-commerce platform to understand tenant isolation, checkout flows, and custom domain routing.

**Key Learning Goals:**
- Design multi-tenant data architecture
- Build secure checkout with payment processing
- Implement custom domain routing at scale
- Handle theme/customization systems

---

## Key Challenges to Explore

### 1. Tenant Isolation

**Requirements:**
- Merchant A cannot see Merchant B's data
- Queries automatically scoped to current tenant
- No cross-tenant data leaks

**Solution: PostgreSQL RLS**
```sql
CREATE POLICY store_isolation ON products
  USING (store_id = current_setting('app.current_store_id')::integer);
```

### 2. Checkout Reliability

**Problem**: Payment succeeds but order creation fails

**Solution: Idempotency**
- Use idempotency keys in Stripe
- Store order before payment confirmation
- Reconcile with webhooks

### 3. Theme Customization

**Balance:**
- Flexibility for merchants
- Performance (caching)
- Security (no arbitrary code execution)

---

## Development Phases

### Phase 1: Store Setup
- [ ] Merchant registration
- [ ] Store creation
- [ ] Subdomain routing

### Phase 2: Products
- [ ] Product CRUD
- [ ] Variants and inventory
- [ ] Collections

### Phase 3: Checkout
- [ ] Cart management
- [ ] Stripe integration
- [ ] Order creation

### Phase 4: Custom Domains
- [ ] Domain verification
- [ ] SSL provisioning
- [ ] Edge routing

---

## Resources

- [Shopify Engineering Blog](https://shopify.engineering/)
- [PostgreSQL Row-Level Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Stripe Connect](https://stripe.com/connect)
