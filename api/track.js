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
    return res.status(404).json({ error: 'Tracking not found', message: error.message });
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

function formatDelhiveryResponse(data) {
  const shipment = data.ShipmentData[0].Shipment;
  const status = shipment.Status;
  const scans = shipment.Scans || [];
  const sortedScans = [...scans].sort((a, b) => new Date(b.ScanDetail.ScanDateTime) - new Date(a.ScanDetail.ScanDateTime));
  const orderRef = (shipment.ReferenceNo || '').replace(/^#/, '');
  
  return [{
    tracking_data: {
      track_status: 1,
      shipment_status: getStatusCode(status?.Status || ''),
      courier_source: 'delhivery',
      shipment_track: [{
        id: orderRef,
        awb_code: shipment.AWB || '',
        shipment_id: orderRef,
        order_id: orderRef,
        pickup_date: shipment.PickUpDate || '',
        delivered_date: shipment.DeliveryDate || '',
        weight: shipment.ChargedWeight ? String(shipment.ChargedWeight) : '0',
        packages: parseInt(shipment.Quantity) || 1,
        current_status: status?.Status || '',
        delivered_to: shipment.Destination || '',
        destination: shipment.Destination || '',
        consignee_name: shipment.Consignee?.Name || '',
        origin: shipment.Origin || '',
        courier_name: 'Delhivery',
        edd: shipment.ExpectedDeliveryDate || null,
        pod: '', pod_status: '',
        rto_delivered_date: shipment.RTOStartedDate || '',
        return_awb_code: '',
        updated_time_stamp: status?.StatusDateTime || ''
      }],
      shipment_track_activities: sortedScans.map(scan => ({
        date: scan.ScanDetail.ScanDateTime,
        status: scan.ScanDetail.Scan,
        activity: scan.ScanDetail.Instructions || scan.ScanDetail.Scan,
        location: scan.ScanDetail.ScannedLocation,
        'sr-status': getStatusCode(scan.ScanDetail.Scan),
        'sr-status-label': scan.ScanDetail.Scan
      })),
      track_url: `https://www.delhivery.com/track/package/${shipment.AWB}`,
      etd: shipment.ExpectedDeliveryDate || null,
      qc_response: '', is_return: false, order_tag: ''
    }
  }];
}

function getStatusCode(status) {
  if (!status) return '6';
  const s = status.toUpperCase();
  if (s.includes('DELIVERED')) return '8';
  if (s.includes('OUT FOR DELIVERY') || s.includes('DISPATCHED')) return '7';
  if (s.includes('IN TRANSIT')) return '6';
  if (s.includes('PICKED') || s.includes('PICKUP')) return '42';
  if (s.includes('PENDING') || s.includes('MANIFESTED')) return '1';
  if (s.includes('RTO')) return '9';
  if (s.includes('CANCELLED')) return '11';
  return '6';
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

async function trackShiprocketByOrderId(orderId) {
  const token = await getShiprocketToken();
  const response = await fetch(
    `https://apiv2.shiprocket.in/v1/external/courier/track?order_id=${encodeURIComponent(orderId)}&channel_id=${SHOPIFY_CHANNEL_ID}`,
    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  const data = await response.json();
  if (!response.ok || !data || data.length === 0) throw new Error('Order not found in Shiprocket');
  if (data[0]?.tracking_data?.error) throw new Error(`Shiprocket: ${data[0].tracking_data.error}`);
  if (data[0]?.tracking_data) data[0].tracking_data.courier_source = 'shiprocket';
  return data;
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
  return [{ tracking_data: { ...data.tracking_data, courier_source: 'shiprocket' } }];
}
