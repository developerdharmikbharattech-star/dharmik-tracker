/**
 * DHARMIK ORDER TRACKING API - WITH DEBUG MODE
 */

let shiprocketToken = null;
let shiprocketTokenExpiry = null;

const SHOPIFY_CHANNEL_ID = 8455465;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // ==================== DEBUG ENDPOINTS ====================
  
  // Check environment variables
  if (req.query.debug === 'check') {
    return res.status(200).json({
      delhivery_token_exists: !!process.env.DELHIVERY_API_TOKEN,
      delhivery_token_preview: process.env.DELHIVERY_API_TOKEN 
        ? process.env.DELHIVERY_API_TOKEN.substring(0, 10) + '...' 
        : 'NOT SET',
      delhivery_token_length: process.env.DELHIVERY_API_TOKEN?.length || 0,
      shiprocket_email: process.env.SHIPROCKET_EMAIL || 'NOT SET',
      shiprocket_password_set: !!process.env.SHIPROCKET_PASSWORD,
      timestamp: new Date().toISOString()
    });
  }
  
  // Test Delhivery API directly
  if (req.query.debug === 'delhivery') {
    const testId = req.query.id || '8440';
    const testType = req.query.type || 'ref_ids'; // or 'waybill'
    
    try {
      const token = process.env.DELHIVERY_API_TOKEN;
      
      if (!token) {
        return res.status(200).json({
          error: 'Delhivery token not set in Vercel'
        });
      }
      
      const url = `https://track.delhivery.com/api/v1/packages/json/?${testType}=${encodeURIComponent(testId)}`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Token ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      const data = await response.json();
      
      return res.status(200).json({
        url_called: url,
        status_code: response.status,
        response_ok: response.ok,
        shipment_count: data.ShipmentData?.length || 0,
        raw_response: data
      });
    } catch (err) {
      return res.status(200).json({
        error: err.message
      });
    }
  }
  
  // ==================== MAIN API ====================
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { orderId, orderNumber, awb } = req.query;
    
    if (awb) {
      const tracking = await trackByAWB(awb);
      return res.status(200).json(tracking);
    }
    
    if (orderId || orderNumber) {
      const tracking = await trackByOrderId(orderId || orderNumber);
      return res.status(200).json(tracking);
    }
    
    return res.status(400).json({ 
      error: 'Missing parameters',
      usage: {
        byOrderId: '/api/track?orderId=8440',
        byAWB: '/api/track?awb=1234567890',
        debugCheck: '/api/track?debug=check',
        debugDelhivery: '/api/track?debug=delhivery&id=8440&type=ref_ids'
      }
    });
    
  } catch (error) {
    console.error('API Error:', error);
    return res.status(404).json({ 
      error: 'Tracking not found',
      message: error.message 
    });
  }
}

async function trackByOrderId(orderIdentifier) {
  const cleanOrderId = orderIdentifier.toString()
    .replace(/^#/, '')
    .replace(/^DHK/i, '')
    .trim();
  
  try {
    const delhiveryData = await trackDelhiveryByOrderId(cleanOrderId);
    if (delhiveryData && delhiveryData.ShipmentData && delhiveryData.ShipmentData.length > 0) {
      return formatDelhiveryResponse(delhiveryData);
    }
  } catch (err) {
    console.log('Delhivery failed:', err.message);
  }
  
  try {
    const shiprocketData = await trackShiprocketByOrderId(cleanOrderId);
    return shiprocketData;
  } catch (err) {
    console.log('Shiprocket failed:', err.message);
  }
  
  throw new Error('Order not found. Please check your order number.');
}

async function trackByAWB(awb) {
  const cleanAWB = awb.toString().trim();
  
  try {
    const delhiveryData = await trackDelhiveryByAWB(cleanAWB);
    if (delhiveryData && delhiveryData.ShipmentData && delhiveryData.ShipmentData.length > 0) {
      return formatDelhiveryResponse(delhiveryData);
    }
  } catch (err) {
    console.log('Delhivery AWB failed:', err.message);
  }
  
  try {
    const shiprocketData = await trackShiprocketByAWB(cleanAWB);
    return shiprocketData;
  } catch (err) {
    console.log('Shiprocket AWB failed:', err.message);
  }
  
  throw new Error('Tracking information not found');
}

async function trackDelhiveryByOrderId(orderId) {
  const delhiveryToken = process.env.DELHIVERY_API_TOKEN;
  
  if (!delhiveryToken) {
    throw new Error('Delhivery API token not configured');
  }
  
  const response = await fetch(
    `https://track.delhivery.com/api/v1/packages/json/?ref_ids=${encodeURIComponent(orderId)}`,
    {
      headers: {
        'Authorization': `Token ${delhiveryToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  if (!response.ok) {
    throw new Error(`Delhivery API returned ${response.status}`);
  }
  
  return await response.json();
}

async function trackDelhiveryByAWB(awb) {
  const delhiveryToken = process.env.DELHIVERY_API_TOKEN;
  
  if (!delhiveryToken) {
    throw new Error('Delhivery API token not configured');
  }
  
  const response = await fetch(
    `https://track.delhivery.com/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`,
    {
      headers: {
        'Authorization': `Token ${delhiveryToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  if (!response.ok) {
    throw new Error(`Delhivery API returned ${response.status}`);
  }
  
  return await response.json();
}

function formatDelhiveryResponse(data) {
  const shipment = data.ShipmentData[0];
  const scans = shipment.Scans || [];
  
  const sortedScans = scans.sort((a, b) => {
    return new Date(b.ScanDetail.ScanDateTime) - new Date(a.ScanDetail.ScanDateTime);
  });
  
  return [{
    tracking_data: {
      track_status: 1,
      shipment_status: getShiprocketStatusCode(shipment.Status.Status),
      courier_source: 'delhivery',
      shipment_track: [{
        awb_code: shipment.Shipment.AWB,
        courier_name: 'Delhivery',
        current_status: shipment.Status.Status,
        destination: shipment.Shipment.DestinationArea,
        origin: shipment.Shipment.OriginArea,
        edd: shipment.Shipment.ExpectedDeliveryDate || null,
        consignee_name: shipment.Shipment.Consignee?.Name || '',
        pickup_date: shipment.Shipment.PickUpDate || '',
        delivered_date: shipment.Shipment.DeliveryDate || ''
      }],
      shipment_track_activities: sortedScans.map(scan => ({
        date: scan.ScanDetail.ScanDateTime,
        status: scan.ScanDetail.Scan,
        activity: scan.ScanDetail.Instructions || scan.ScanDetail.Scan,
        location: scan.ScanDetail.ScannedLocation,
        'sr-status-label': scan.ScanDetail.Scan
      })),
      track_url: `https://www.delhivery.com/track/package/${shipment.Shipment.AWB}`,
      etd: shipment.Shipment.ExpectedDeliveryDate || null
    }
  }];
}

function getShiprocketStatusCode(status) {
  const statusUpper = status.toUpperCase();
  if (statusUpper.includes('DELIVERED')) return '8';
  if (statusUpper.includes('OUT FOR DELIVERY')) return '7';
  if (statusUpper.includes('IN TRANSIT')) return '6';
  if (statusUpper.includes('PICKED')) return '42';
  return '6';
}

async function getShiprocketToken() {
  if (shiprocketToken && shiprocketTokenExpiry && Date.now() < shiprocketTokenExpiry) {
    return shiprocketToken;
  }
  
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  
  if (!email || !password) {
    throw new Error('Shiprocket credentials not configured');
  }
  
  const response = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.message || 'Shiprocket authentication failed');
  }
  
  shiprocketToken = data.token;
  shiprocketTokenExpiry = Date.now() + (9 * 24 * 60 * 60 * 1000);
  
  return shiprocketToken;
}

async function trackShiprocketByOrderId(orderId) {
  const token = await getShiprocketToken();
  
  const response = await fetch(
    `https://apiv2.shiprocket.in/v1/external/courier/track?order_id=${encodeURIComponent(orderId)}&channel_id=${SHOPIFY_CHANNEL_ID}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  const data = await response.json();
  
  if (!response.ok || !data || data.length === 0) {
    throw new Error('Order not found in Shiprocket');
  }
  
  if (data[0] && data[0].tracking_data) {
    data[0].tracking_data.courier_source = 'shiprocket';
  }
  
  return data;
}

async function trackShiprocketByAWB(awb) {
  const token = await getShiprocketToken();
  
  const response = await fetch(
    `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${encodeURIComponent(awb)}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error('AWB not found in Shiprocket');
  }
  
  return [{
    tracking_data: {
      ...data.tracking_data,
      courier_source: 'shiprocket'
    }
  }];
}
