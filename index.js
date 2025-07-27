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
  credential: admin.credential.cert(serviceAccount)
});

app.post('/trial', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) return res.status(400).json({ error: 'No idToken provided' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    const userRecord = await admin.auth().getUser(uid);
    const createdAtMs = new Date(userRecord.metadata.creationTime).getTime();
    const createdAt = Math.floor(createdAtMs / 1000);
    const trialExpireDate = createdAt + 7 * 24 * 60 * 60;

    if (decoded.trialExpireDate != null) {
      return res.status(400).json({ error: 'Trial already set' });
    }

    await admin.auth().setCustomUserClaims(uid, {
      trialExpireDate
    });

    res.json({ success: true, trialExpireDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set trial' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${process.env.PORT || 8080}`);
});
