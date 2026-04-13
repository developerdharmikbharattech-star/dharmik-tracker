// File: api/track.js
// DEBUG VERSION — shows detailed errors to help troubleshoot
// Once working, replace with the production version

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { order_id } = req.query;

  if (!order_id) {
    return res.status(400).json({ error: "Order ID is required" });
  }

  // Debug: check if env variables exist
  const hasEmail = !!process.env.SHIPROCKET_EMAIL;
  const hasPassword = !!process.env.SHIPROCKET_PASSWORD;

  if (!hasEmail || !hasPassword) {
    return res.status(500).json({
      error: "Missing environment variables",
      debug: {
        SHIPROCKET_EMAIL_set: hasEmail,
        SHIPROCKET_PASSWORD_set: hasPassword,
      },
    });
  }

  try {
    // Step 1: Authenticate
    const authResponse = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.SHIPROCKET_EMAIL,
        password: process.env.SHIPROCKET_PASSWORD,
      }),
    });

    const authText = await authResponse.text();

    if (!authResponse.ok) {
      return res.status(500).json({
        error: "Shiprocket authentication failed",
        debug: {
          step: "auth",
          status: authResponse.status,
          response: authText.substring(0, 500),
        },
      });
    }

    let authData;
    try {
      authData = JSON.parse(authText);
    } catch (e) {
      return res.status(500).json({
        error: "Could not parse auth response",
        debug: { step: "auth_parse", response: authText.substring(0, 500) },
      });
    }

    const token = authData.token;

    if (!token) {
      return res.status(500).json({
        error: "No token received from Shiprocket",
        debug: { step: "auth_token", response: authData },
      });
    }

    // Step 2: Search for order
    const orderUrl = `https://apiv2.shiprocket.in/v1/external/orders?search=${encodeURIComponent(order_id)}&page=1&per_page=1`;
    const orderResponse = await fetch(orderUrl, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const orderText = await orderResponse.text();

    if (!orderResponse.ok) {
      return res.status(500).json({
        error: "Failed to fetch order from Shiprocket",
        debug: {
          step: "order_search",
          url: orderUrl,
          status: orderResponse.status,
          response: orderText.substring(0, 500),
        },
      });
    }

    let orderData;
    try {
      orderData = JSON.parse(orderText);
    } catch (e) {
      return res.status(500).json({
        error: "Could not parse order response",
        debug: { step: "order_parse", response: orderText.substring(0, 500) },
      });
    }

    // Check if order found
    if (!orderData.data || orderData.data.length === 0) {
      return res.status(404).json({
        error: "Order not found. Please check your order number.",
        debug: {
          step: "order_not_found",
          search_term: order_id,
          raw_response_keys: Object.keys(orderData),
          total_count: orderData.meta?.pagination?.total || 0,
        },
      });
    }

    const order = orderData.data[0];
    const shipments = order.shipments;

    // Not shipped yet
    if (!shipments || shipments.length === 0) {
      return res.status(200).json({
        order_id: order.channel_order_id,
        status: order.status_code === 1 ? "NEW" : order.status,
        message: "Your order has been received and is being processed. Shipping details will be available soon.",
        shipped: false,
        order_date: order.created_at,
        customer_name: `${order.customer_name || ""}`.trim(),
        products: order.products || [],
      });
    }

    // Step 3: Get tracking
    const awb = shipments[0].awb;
    const courier = shipments[0].courier_name;

    if (!awb) {
      return res.status(200).json({
        order_id: order.channel_order_id,
        status: "PROCESSING",
        message: "Your order is being prepared for shipping. Tracking will be available once shipped.",
        shipped: false,
        order_date: order.created_at,
        customer_name: `${order.customer_name || ""}`.trim(),
        products: order.products || [],
      });
    }

    const trackUrl = `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`;
    const trackResponse = await fetch(trackUrl, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const trackText = await trackResponse.text();

    if (!trackResponse.ok) {
      return res.status(500).json({
        error: "Failed to fetch tracking data",
        debug: {
          step: "tracking",
          awb: awb,
          status: trackResponse.status,
          response: trackText.substring(0, 500),
        },
      });
    }

    let trackData;
    try {
      trackData = JSON.parse(trackText);
    } catch (e) {
      return res.status(500).json({
        error: "Could not parse tracking response",
        debug: { step: "tracking_parse", response: trackText.substring(0, 500) },
      });
    }

    const tracking = trackData.tracking_data || {};

    return res.status(200).json({
      order_id: order.channel_order_id,
      shipped: true,
      awb: awb,
      courier: courier,
      status: tracking.shipment_status_id
        ? getStatusLabel(tracking.shipment_status_id)
        : shipments[0].status,
      current_status: tracking.shipment_track?.[0]?.current_status || "",
      etd: tracking.etd || "",
      order_date: order.created_at,
      customer_name: `${order.customer_name || ""}`.trim(),
      shipment_track: tracking.shipment_track || [],
      shipment_track_activities: tracking.shipment_track_activities || [],
      products: order.products || [],
    });

  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error",
      debug: {
        step: "catch",
        message: error.message,
        name: error.name,
      },
    });
  }
}

function getStatusLabel(statusId) {
  const statusMap = {
    1: "AWB Assigned",
    2: "Picked Up",
    3: "In Transit",
    4: "Out for Delivery",
    5: "Delivered",
    6: "Undelivered",
    7: "Returned",
    8: "Cancelled",
  };
  return statusMap[statusId] || "In Process";
}
