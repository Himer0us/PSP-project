const e = require('express');
const express = require('express');
const app = express();
const port = 3001;

app.use(express.json());

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mysql = require('mysql2/promise');

const https = require('https');
const http = require('http');

const client = require('prom-client');
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const paymentSuccessCounter = new client.Counter({
  name: 'payment_success_total',
  help: 'Total number of successful payments',
  labelNames: ['currency']
});

const paymentFailedCounter = new client.Counter({
  name: 'payment_failed_total', 
  help: 'Total number of failed payments',
  labelNames: ['currency', 'error_code']
});

register.registerMetric(paymentSuccessCounter);
register.registerMetric(paymentFailedCounter);

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

app.post('/create-transaction',async (req, res) => {
  
try{
  const paymentIntent = await stripe.paymentIntents.create({
  amount: 2000,
  currency: 'usd',
  automatic_payment_methods: {
    enabled: true,
  },
});

await db.query(
  'INSERT INTO payments (amount, currency, stripe_payment_intent_id, status) VALUES (?, ?, ?, ?)',
  [paymentIntent.amount, paymentIntent.currency, paymentIntent.id, paymentIntent.status]
);

res.status(200).send({clientSecret: paymentIntent.client_secret});

}  catch(error){
  console.error('Error creating PaymentIntent:', error);
  res.status(500).send({ error: error.message });
}
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items:[
        {price_data:{
          currency: 'usd',
          product_data: {
            name: 'T-shirt',
          },
          unit_amount: 2000,
        },
        quantity: 1
      },
      ],
      mode:'payment',
      success_url: 'http://localhost:3000/success.html',
      cancel_url: 'http://localhost:3000/cancel.html',
    });
    await db.query(
      'INSERT INTO payments (amount, currency, stripe_payment_intent_id, status) VALUES (?, ?, ?, ?)',
      [2000, 'usd', session.id, 'requires_payment_method']
    );
    res.json({ url: session.url});
  } catch (error) {
    console.error('Error creating Checkout Session:', error);
    res.status(500).send({ error: error.message });
  }
});

app.post('/refund-payment', async (req, res) => {
  try {
    const { paymentIntentId, amount } = req.body;
    
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amount,
    });

    
    await db.query(
      'UPDATE payments SET status = ? WHERE stripe_payment_intent_id = ?',
      ['refunded', paymentIntentId]
    );

    
    const esData = {
      payment_intent_id: paymentIntentId,
      refund_id: refund.id,
      amount: refund.amount,
      status: refund.status,
      timestamp: new Date().toISOString()
    };

    const postData = JSON.stringify(esData);
    const options = {
      hostname: 'elasticsearch',
      port: 9200,
      path: '/refunds/_doc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      }
    };

    const esReq = http.request(options, (esRes) => {
      console.log(`Refund logged to Elasticsearch: ${esRes.statusCode}`);
    });

    esReq.on('error', (error) => {
      console.error('Error logging refund to Elasticsearch:', error);
    });

    esReq.write(postData);
    esReq.end();

    res.json({ 
      success: true, 
      refundId: refund.id,
      status: refund.status,
      amount: refund.amount
    });

  } catch (error) {
    console.error('Error processing refund:', error);
    res.status(500).send({ error: error.message });
  }
});

app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  let event = req.body;
  if (endpointSecret) {
  const signature = req.headers['stripe-signature'];
  try{
    event = stripe.webhooks.constructEvent(req.body,signature,endpointSecret);
  } catch (err) {
    console.log('Webhook signature verification failed.', err.message);
    return res.sendStatus(400);
  }
  switch(event.type){
    case 'checkout.session.completed':
    const session = event.data.object;
    console.log('Checkout session completed, payment_intent:', session.payment_intent);
  
    await db.query(
    'UPDATE payments SET stripe_payment_intent_id = ? WHERE stripe_payment_intent_id = ?',
    [session.payment_intent, session.id]  
    );
    break;
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      console.log('DEBUG: Updating payment:', paymentIntent.id);
      
      const [existing] = await db.query(
    'SELECT * FROM payments WHERE stripe_payment_intent_id = ?',
    [paymentIntent.id]
  );
    console.log('DEBUG: Found in database:', existing);
  
    
    const [result] = await db.query(
    'UPDATE payments SET status = ? WHERE stripe_payment_intent_id = ?',
    ['succeeded', paymentIntent.id]
    );
      console.log('DEBUG: Update result - affected rows:', result.affectedRows);
      console.log('PaymentIntent was successful!');
      paymentSuccessCounter.inc({ currency: paymentIntent.currency });
      break;
    case 'payment_intent.payment_failed':
      const failedPaymentIntent = event.data.object;
      
      await db.query(
        'UPDATE payments SET status = ? WHERE stripe_payment_intent_id = ?',
    ['failed', failedPaymentIntent.id]
      );

       const esData = {
    payment_intent_id: failedPaymentIntent.id,
    error: failedPaymentIntent.last_payment_error,
    amount: failedPaymentIntent.amount,
    currency: failedPaymentIntent.currency,
    timestamp: new Date().toISOString()
  };

  const postData = JSON.stringify(esData);
  const options = {
    hostname: 'elasticsearch',
    port: 9200,
    path: '/failed-payments/_doc',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': postData.length
    }
  };

  const esReq = http.request(options, (esRes) => {
    console.log(`Elasticsearch response: ${esRes.statusCode}`);
  });

  esReq.on('error', (error) => {
    console.error('Error sending to Elasticsearch:', error);
  });

  esReq.write(postData);
  esReq.end();
  paymentFailedCounter.inc({ 
  currency: failedPaymentIntent.currency,
  error_code: failedPaymentIntent.last_payment_error?.code || 'unknown'
  });
  
  console.error('Payment failed:', {
    payment_intent_id: failedPaymentIntent.id,
    error: failedPaymentIntent.last_payment_error
  });
  break;
    case 'payment_intent.canceled':
      const canceledPaymentIntent = event.data.object;
       await db.query(
    'UPDATE payments SET status = ? WHERE stripe_payment_intent_id = ?',
    ['canceled', canceledPaymentIntent.id]
  );
  break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }
  } 
  res.sendStatus(200);
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// A simple test route
app.get('/health', (req, res) => {
  res.json({ message: 'Server is alive!' });
});

// Make the app listen
app.listen(port, () => {
  console.log(`Backend server listening on port ${port}`);
});