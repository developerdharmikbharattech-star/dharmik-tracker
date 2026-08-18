let shiprocketToken = null;
let shiprocketTokenExpiry = null;
const SHOPIFY_CHANNEL_ID = 8455465;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query.debug === 'check') {
    return res.status(200).json({
      delhivery_token_exists: !!process.env.DELHIVERY_API_TOKEN,
      shiprocket_email: process.env.SHIPROCKET_EMAIL || 'NOT SET',
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const q = req.query;
    const finalOrderId = q.orderId || q.order_id || q.orderNumber || q.order_number;
    const finalAwb = q.awb || q.awb_number || q.awb_code;

    if (finalAwb) {
      return res.status(200).json(await trackByAWB(finalAwb));
    }
    if (finalOrderId) {
      return res.status(200).json(await trackByOrderId(finalOrderId));
    }

    return res.status(400).json({
      error: 'Missing parameters',
      received: q,
      usage: { byOrderId: '/api/track?orderId=21079', byOrderIdAlt: '/api/track?order_id=21079' }
    });
  } catch (error) {
    // Matches the frontend's expected "not found / not shipped" shape instead of
    // a bare 404 error object, so the UI can render something sensible.
    return res.status(200).json({
      shipped: false,
      order_id: req.query.orderId || req.query.order_id || req.query.orderNumber || req.query.order_number || '',
      status: 'Not Found',
      message: error.message || 'Order not found. Please check your order number.'
    });
  }
}

async function trackByOrderId(orderIdentifier) {
  const numericId = orderIdentifier.toString().trim().replace(/^DHK/i, '').replace(/^#/, '').trim();
  const delhiveryId = '#' + numericId;
  const shiprocketId = numericId;

  try {
    const data = await trackDelhiveryByOrderId(delhiveryId);
    if (data?.ShipmentData?.length > 0) return formatDelhiveryResponse(data);
  } catch (err) { console.log('Delhivery failed:', err.message); }

  try {
    return await trackShiprocketByOrderId(shiprocketId);
  } catch (err) { console.log('Shiprocket failed:', err.message); }

  throw new Error('Order not found. Please check your order number.');
}

async function trackByAWB(awb) {
  const cleanAWB = awb.toString().trim();

  try {
    const data = await trackDelhiveryByAWB(cleanAWB);
    if (data?.ShipmentData?.length > 0) return formatDelhiveryResponse(data);
  } catch (err) { console.log('Delhivery AWB failed:', err.message); }

  try {
    return await trackShiprocketByAWB(cleanAWB);
  } catch (err) { console.log('Shiprocket AWB failed:', err.message); }

  throw new Error('Tracking information not found');
}

async function trackDelhiveryByOrderId(orderId) {
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) throw new Error('Delhivery token not configured');
  const response = await fetch(
    `https://track.delhivery.com/api/v1/packages/json/?ref_ids=${encodeURIComponent(orderId)}`,
    { headers: { 'Authorization': `Token ${token}`, 'Content-Type': 'application/json' } }
  );
  if (!response.ok) throw new Error(`Delhivery returned ${response.status}`);
  return await response.json();
}

async function trackDelhiveryByAWB(awb) {
  const token = process.env.DELHIVERY_API_TOKEN;
  if (!token) throw new Error('Delhivery token not configured');
  const response = await fetch(
    `https://track.delhivery.com/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`,
    { headers: { 'Authorization': `Token ${token}`, 'Content-Type': 'application/json' } }
  );
  if (!response.ok) throw new Error(`Delhivery returned ${response.status}`);
  return await response.json();
}

// Returns the FLAT shape the frontend (dt-tracker widget) expects:
// { shipped, order_id, awb, courier, current_status, status, etd,
//   customer_name, order_date, shipment_track_activities: [...] }
function formatDelhiveryResponse(data) {
  const shipment = data.ShipmentData[0].Shipment;
  const status = shipment.Status;
  const scans = shipment.Scans || [];
  const sortedScans = [...scans].sort(
    (a, b) => new Date(b.ScanDetail.ScanDateTime) - new Date(a.ScanDetail.ScanDateTime)
  );
  const orderRef = (shipment.ReferenceNo || '').replace(/^#/, '');
  const statusText = status?.Status || '';

  return {
    shipped: true,
    order_id: orderRef,
    awb: shipment.AWB || '',
    courier: 'Delhivery',
    current_status: statusText,
    status: statusText,
    etd: shipment.ExpectedDeliveryDate || null,
    customer_name: shipment.Consignee?.Name || '',
    order_date: shipment.PickUpDate || null,
    destination: shipment.Destination || '',
    origin: shipment.Origin || '',
    track_url: `https://www.delhivery.com/track/package/${shipment.AWB}`,
    shipment_track_activities: sortedScans.map(scan => ({
      date: scan.ScanDetail.ScanDateTime,
      status: scan.ScanDetail.Scan,
      activity: scan.ScanDetail.Instructions || scan.ScanDetail.Scan,
      location: scan.ScanDetail.ScannedLocation,
      'sr-status-label': scan.ScanDetail.Scan
    }))
  };
}

async function getShiprocketToken() {
  if (shiprocketToken && shiprocketTokenExpiry && Date.now() < shiprocketTokenExpiry) return shiprocketToken;
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) throw new Error('Shiprocket credentials not configured');
  const response = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Shiprocket auth failed');
  shiprocketToken = data.token;
  shiprocketTokenExpiry = Date.now() + (9 * 24 * 60 * 60 * 1000);
  return shiprocketToken;
}

// Flattens Shiprocket's nested tracking_data into the same shape as Delhivery's.
function formatShiprocketResponse(raw) {
  const td = raw?.tracking_data || raw?.[0]?.tracking_data || {};
  if (td.error) throw new Error(`Shiprocket: ${td.error}`);

  const trackInfo = (td.shipment_track && td.shipment_track[0]) || {};
  const activities = td.shipment_track_activities || [];

  return {
    shipped: true,
    order_id: (trackInfo.order_id || trackInfo.id || '').toString(),
    awb: trackInfo.awb_code || '',
    courier: trackInfo.courier_name || 'Shiprocket',
    current_status: trackInfo.current_status || '',
    status: trackInfo.current_status || '',
    etd: td.etd || null,
    customer_name: trackInfo.consignee_name || '',
    order_date: trackInfo.pickup_date || null,
    destination: trackInfo.destination || '',
    origin: trackInfo.origin || '',
    track_url: td.track_url || '',
    shipment_track_activities: activities.map(a => ({
      date: a.date,
      status: a.status,
      activity: a.activity || a['sr-status-label'] || a.status,
      location: a.location,
      'sr-status-label': a['sr-status-label'] || a.status
    }))
  };
}

async function trackShiprocketByOrderId(orderId) {
  const token = await getShiprocketToken();
  const response = await fetch(
    `https://apiv2.shiprocket.in/v1/external/courier/track?order_id=${encodeURIComponent(orderId)}&channel_id=${SHOPIFY_CHANNEL_ID}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  const data = await response.json();
  if (!response.ok || !data || data.length === 0) throw new Error('Order not found in Shiprocket');
  if (data[0]?.tracking_data?.error) throw new Error(`Shiprocket: ${data[0].tracking_data.error}`);
  return formatShiprocketResponse(data[0]);
}

async function trackShiprocketByAWB(awb) {
  const token = await getShiprocketToken();
  const response = await fetch(
    `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${encodeURIComponent(awb)}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  const data = await response.json();
  if (!response.ok) throw new Error('AWB not found in Shiprocket');
  if (data.tracking_data?.error) throw new Error(`Shiprocket: ${data.tracking_data.error}`);
  return formatShiprocketResponse(data);
}
