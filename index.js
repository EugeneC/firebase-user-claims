import express from 'express';
import dotenv from 'dotenv';
import admin from 'firebase-admin';

dotenv.config();

const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(
  Buffer.from(process.env.GOOGLE_CREDENTIALS, 'base64').toString()
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.post('/trial', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) return res.status(400).json({ error: 'No idToken provided' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (decoded.trialExpireDate != null) {
      return res.status(400).json({ error: 'Trial already set' });
    }

    const uid = decoded.uid;
    const userRecord = await admin.auth().getUser(uid);
    const createdAtMs = new Date(userRecord.metadata.creationTime).getTime();
    const trialExpireDate = createdAtMs + 7 * 24 * 60 * 60 * 1000;

    await admin.auth().setCustomUserClaims(uid, {
        trialExpireDate: trialExpireDate,
        hasPremium: decoded.hasPremium,
    });

    res.json({ success: true, trialExpireDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set trial' });
  }
});

app.post('/premium', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'No idToken provided' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (decoded.hasPremium != null && decoded.hasPremium == true) {
      return res.status(400).json({ error: 'Premium already set' });
    }

    const uid = decoded.uid;

    const adaptyResponse = await fetch(`https://api.adapty.io/api/v2/server-side-api/profile/`, {
      method: 'GET',
      headers: {
        'Authorization': `Api-Key ${process.env.ADAPTY_API_KEY}`,
        'Content-Type': 'application/json',
        'adapty-customer-user-id': uid
      },
    });

    if (!adaptyResponse.ok) {
      const errText = await adaptyResponse.text();
      console.error('Adapty error:', errText);
      return res.status(500).json({ error: 'Failed to fetch subscription from Adapty' });
    }

    const adaptyData = await adaptyResponse.json();

    const hasPremium = hasActiveSubscription(adaptyData);
    if (hasPremium) {
      await admin.auth().setCustomUserClaims(uid, {
        trialExpireDate: decoded.trialExpireDate,
        hasPremium: true,
      });
    }

    res.json({ success: true, hasPremium });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update premium status' });
  }
});

app.put('/premium', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) return res.status(400).json({ error: 'No idToken provided' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    if (!decoded.hasPremium) {
      return res.json({ skipped: true, reason: 'No hasPremium claim' });
    }

    const now = Date.now();
    if (decoded.lastSubscriptionCheck && now - decoded.lastSubscriptionCheck < 24 * 60 * 60 * 1000) {
      return res.json({ skipped: true, reason: 'Checked less than 24h ago' });
    }

    const userRecord = await admin.auth().getUser(uid);
    const userEmail = userRecord.email;

    const skipEmails = (process.env.SKIP_ADAPTY_EMAILS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    let hasPremium = false;
    if (skipEmails.includes(userEmail.toLowerCase())) {
      hasPremium = true;
    } else {
      const adaptyResponse = await fetch(`https://api.adapty.io/api/v2/server-side-api/profile/`, {
        method: 'GET',
        headers: {
          'Authorization': `Api-Key ${process.env.ADAPTY_API_KEY}`,
          'Content-Type': 'application/json',
          'adapty-customer-user-id': uid
        },
      });

      if (!adaptyResponse.ok) {
        hasPremium = false;
      } else {
        const adaptyData = await adaptyResponse.json();

        hasPremium = hasActiveSubscription(adaptyData);
      }
    }
    
    if (!hasPremium) {
      await admin.auth().setCustomUserClaims(uid, {
        trialExpireDate: decoded.trialExpireDate,
      });

      return res.json({ updated: true, hasPremium: false });
    } else {
      await admin.auth().setCustomUserClaims(uid, {
        trialExpireDate: decoded.trialExpireDate,
        hasPremium: hasPremium,
        lastSubscriptionCheck: now
      });
      return res.json({ updated: true, hasPremium: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update premium status' });
  }
});

function hasActiveSubscription(adaptyData) {
  if (!adaptyData?.data?.access_levels || !Array.isArray(adaptyData.data.access_levels)) {
    return false;
  }

  const now = new Date();

  return adaptyData.data.access_levels.some(level => {
    const startsAt = level.starts_at ? new Date(level.starts_at) : null;
    const expiresAt = level.expires_at ? new Date(level.expires_at) : null;

    // Если есть дата начала — проверяем, что уже началась
    const hasStarted = !startsAt || now >= startsAt;

    // Если есть дата окончания — проверяем, что ещё не закончилась
    const notExpired = !expiresAt || now <= expiresAt;

    return hasStarted && notExpired;
  });
}

app.post('/notify', async (req, res) => {
  const { idToken, checklistId, userUids, content } = req.body;

  if (!idToken || !userUids || !content) {
    return res.status(400).json({ error: 'Missing required fields: idToken, userUids or content.' });
  }

  const { titles, messages } = content;
    if (!titles || !messages) {
    return res.status(400).json({ error: 'Missing content required fields: titles or messages.' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const now = Date.now();
    if (!decoded.hasPremium && (!decoded.trialExpireDate || now > decoded.trialExpireDate)) {
      return res.status(500).json({ error: 'User has no permissions.' });
    }

    const payload = {
      app_id: process.env.OS_APP_ID,
      include_external_user_ids: Array.from(userUids),
      headings: content["titles"],
      contents: content["messages"],
      android_channel_id: process.env.OS_ANDROID_CHANNEL_ID,
      thread_id: `${process.env.ANDROID_PACKAGE_NAME}.checklist_updates`,
      android_group: `${process.env.ANDROID_PACKAGE_NAME}.checklist_updates`,
    };

    if (checklistId != null) {
      payload.data = {
        checklistId: checklistId,
        collapse_id: checklistId,
      };
    }

    const r = await fetch(`${process.env.OS_API_BASE_URL}/notifications?c=push`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${process.env.OS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    

    res.json(await r.json());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
