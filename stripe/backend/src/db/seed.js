import { query } from './pool.js';
import { v4 as uuidv4 } from 'uuid';
import { generateApiKey, hashApiKey, generateWebhookSecret, generateCardToken } from '../utils/helpers.js';
import dotenv from 'dotenv';

dotenv.config();

async function seed() {
  console.log('Seeding database...');

  try {
    // Create demo merchant
    const merchantId = uuidv4();
    const apiKey = 'sk_test_demo_merchant_key_12345';
    const apiKeyHash = hashApiKey(apiKey);
    const webhookSecret = generateWebhookSecret();

    await query(`
      INSERT INTO merchants (id, name, email, api_key, api_key_hash, webhook_secret, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'active')
      ON CONFLICT (email) DO NOTHING
    `, [merchantId, 'Demo Merchant', 'demo@example.com', apiKey, apiKeyHash, webhookSecret]);

    console.log('Created demo merchant:');
    console.log(`  Email: demo@example.com`);
    console.log(`  API Key: ${apiKey}`);
    console.log(`  Webhook Secret: ${webhookSecret}`);

    // Get merchant ID (in case it already existed)
    const merchantResult = await query(`SELECT id FROM merchants WHERE email = 'demo@example.com'`);
    const actualMerchantId = merchantResult.rows[0].id;

    // Create demo customers
    const customers = [
      { name: 'John Doe', email: 'john@example.com' },
      { name: 'Jane Smith', email: 'jane@example.com' },
      { name: 'Bob Wilson', email: 'bob@example.com' },
    ];

    const customerIds = [];
    for (const customer of customers) {
      const customerId = uuidv4();
      await query(`
        INSERT INTO customers (id, merchant_id, name, email)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
      `, [customerId, actualMerchantId, customer.name, customer.email]);
      customerIds.push(customerId);
    }
    console.log(`Created ${customers.length} demo customers`);

    // Create demo payment methods
    const testCards = [
      { number: '4242424242424242', brand: 'visa', last4: '4242' },
      { number: '5555555555554444', brand: 'mastercard', last4: '4444' },
      { number: '378282246310005', brand: 'amex', last4: '0005' },
    ];

    const paymentMethodIds = [];
    for (let i = 0; i < testCards.length; i++) {
      const card = testCards[i];
      const pmId = uuidv4();
      const token = generateCardToken(card.number);

      await query(`
        INSERT INTO payment_methods
          (id, customer_id, merchant_id, type, card_token, card_last4, card_brand, card_exp_month, card_exp_year, card_bin)
        VALUES ($1, $2, $3, 'card', $4, $5, $6, 12, 2027, $7)
        ON CONFLICT DO NOTHING
      `, [pmId, customerIds[i % customerIds.length], actualMerchantId, token, card.last4, card.brand, card.number.slice(0, 6)]);
      paymentMethodIds.push(pmId);
    }
    console.log(`Created ${testCards.length} demo payment methods`);

    // Create some demo payment intents and charges
    const amounts = [2500, 5000, 7500, 10000, 15000]; // $25, $50, $75, $100, $150
    const statuses = ['succeeded', 'succeeded', 'succeeded', 'requires_payment_method', 'failed'];

    for (let i = 0; i < amounts.length; i++) {
      const piId = uuidv4();
      const amount = amounts[i];
      const status = statuses[i];
      const pmId = paymentMethodIds[i % paymentMethodIds.length];
      const customerId = customerIds[i % customerIds.length];

      await query(`
        INSERT INTO payment_intents
          (id, merchant_id, customer_id, amount, currency, status, payment_method_id)
        VALUES ($1, $2, $3, $4, 'usd', $5, $6)
        ON CONFLICT DO NOTHING
      `, [piId, actualMerchantId, customerId, amount, status, pmId]);

      // Create charge and ledger entries for succeeded payments
      if (status === 'succeeded') {
        const chargeId = uuidv4();
        const fee = Math.round(amount * 0.029 + 30);
        const net = amount - fee;

        await query(`
          INSERT INTO charges
            (id, payment_intent_id, merchant_id, amount, currency, status, payment_method_id, fee, net)
          VALUES ($1, $2, $3, $4, 'usd', 'succeeded', $5, $6, $7)
          ON CONFLICT DO NOTHING
        `, [chargeId, piId, actualMerchantId, amount, pmId, fee, net]);

        // Create ledger entries
        const txId = uuidv4();
        await query(`
          INSERT INTO ledger_entries (transaction_id, account, debit, credit, payment_intent_id, charge_id, description)
          VALUES
            ($1, 'funds_receivable', $2, 0, $3, $4, 'Card payment received'),
            ($1, $5, 0, $6, $3, $4, 'Merchant payment due'),
            ($1, 'revenue:transaction_fees', 0, $7, $3, $4, 'Processing fee')
          ON CONFLICT DO NOTHING
        `, [txId, amount, piId, chargeId, `merchant:${actualMerchantId}:payable`, net, fee]);
      }
    }
    console.log(`Created ${amounts.length} demo payment intents`);

    console.log('\nSeed completed successfully!');
    console.log('\nTo test the API, use:');
    console.log(`curl -H "Authorization: Bearer ${apiKey}" http://localhost:3001/v1/payment_intents`);

    process.exit(0);
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
}

seed();
