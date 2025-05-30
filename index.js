const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
app.use(express.json());
const sendNotification = async (playerId, title, message) => {
  const url = "https://api.onesignal.com/notifications?c=push";
  const options = {
    method: "POST",
    headers: {
      accept: "application/json",
      Authorization:
        "Key os_v2_app_dcg7swl5pnh3ll7ljjyfrhrqctcchw45w4peeumwiy3pfx2ajiztxhznumsdybqwrybdafe4w7xlfruw2vpnjzagbpl7kpq2mrby63y",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      app_id: "188df959-7d7b-4fb5-afeb-4a70589e3014",
      contents: { en: message },
      headings: { en: title },
      include_player_ids: [playerId],
    }),
  };
  fetch(url, options)
    .then((res) => res.json())
    .then((json) => console.log(json))
    .catch((err) => console.error(err));
};
// MySQL bağlantısı
const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "", // kendi şifreni yaz
  database: "fato-melo", // kendi db ismini yaz
});

// /api/budget endpoint'i
app.post("/api/budget", async (req, res) => {
  let { startDate, endDate } = req.body;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: "startDate and endDate are required" });
  }
  startDate = startDate.split(".").reverse().join("-");
  endDate = endDate.split(".").reverse().join("-");
  console.log(startDate, endDate);

  const conn = await pool.getConnection();
  try {
    // 1. Bu hafta daha önce var mı?
    const [existingRows] = await conn.execute("SELECT * FROM weekly_budget WHERE start_date = ? AND end_date = ?", [
      startDate,
      endDate,
    ]);

    let week;
    if (existingRows.length > 0) {
      week = existingRows[0];
    } else {
      // 2. Settings'ten toplam aylık bütçeyi çek
      const [settingsRows] = await conn.execute("SELECT total_budget FROM settings LIMIT 1");
      if (settingsRows.length === 0) {
        return res.status(500).json({ error: "Settings not found" });
      }

      const monthlyBudget = parseFloat(settingsRows[0].total_budget);
      const weeklyBaseBudget = monthlyBudget / 4;

      // 3. Önceki haftaları al (sıralı)
      const [previousWeeks] = await conn.execute(
        "SELECT budget, spent FROM weekly_budget WHERE start_date < ? ORDER BY start_date DESC LIMIT 1",
        [startDate]
      );

      // 4. Farkları hesapla
      let adjustment = 0;
      for (const w of previousWeeks) {
        const diff = parseFloat(w.budget) - parseFloat(w.spent || 0);
        adjustment += diff;
      }

      const adjustedBudget = Math.max(0, weeklyBaseBudget + adjustment);

      // 5. Yeni haftayı oluştur
      await conn.execute("INSERT INTO weekly_budget (start_date, end_date, budget, spent) VALUES (?, ?, ?, 0)", [
        startDate,
        endDate,
        adjustedBudget,
      ]);

      // 6. Oluşan veriyi al
      const [newRows] = await conn.execute("SELECT * FROM weekly_budget WHERE start_date = ? AND end_date = ?", [
        startDate,
        endDate,
      ]);

      week = newRows[0];
    }

    // 7. O haftaya ait harcamaları çek
    const [melo_expenses] = await conn.execute(
      "SELECT id, name, expense, created_at FROM expenses WHERE week_id = ? AND name = ? ORDER BY created_at DESC",
      [week.id, "melo"]
    );

    const [fato_expenses] = await conn.execute(
      "SELECT id, name, expense, created_at FROM expenses WHERE week_id = ? AND name = ? ORDER BY created_at DESC",
      [week.id, "fato"]
    );

    // 8. Sonucu harcamalarla birlikte döndür
    res.json({
      ...week,
      melo_expenses,
      fato_expenses,
    });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    conn.release();
  }
});

app.post("/api/expenses", async (req, res) => {
  let { startDate, endDate, whoAreYou, expense } = req.body;
  let name = whoAreYou;
  if (!startDate || !endDate || !name || expense == null) {
    return res.status(400).json({ error: "startDate, endDate, name and expense are required" });
  }
  startDate = startDate.split(".").reverse().join("-");
  endDate = endDate.split(".").reverse().join("-");
  const conn = await pool.getConnection();
  try {
    // Haftalık bütçe kaydını bul
    const [weekRows] = await conn.execute("SELECT * FROM weekly_budget WHERE start_date = ? AND end_date = ?", [
      startDate,
      endDate,
    ]);

    if (weekRows.length === 0) {
      return res.status(400).json({ error: "Weekly budget record not found" });
    }

    const week = weekRows[0];

    // Harcamayı ekle
    const [result] = await conn.execute("INSERT INTO expenses (week_id, name, expense) VALUES (?, ?, ?)", [
      week.id,
      name,
      expense,
    ]);

    // Haftalık bütçedeki harcama toplamını güncelle
    await conn.execute("UPDATE weekly_budget SET spent = spent + ? WHERE id = ?", [expense, week.id]);

    // Yeni eklenen harcamayı al
    const [newExpenseRows] = await conn.execute("SELECT * FROM expenses WHERE id = ?", [result.insertId]);
    if (name == "melo") {
      await sendNotification(
        "a9ff4c2b-326b-4a0b-b981-6f67d9621bfc",
        "Melo Paraları Saçıyor.",
        "Melo " + expense + " TL harcadı."
      );
    } else {
      await sendNotification(
        "161402fd-e05a-4504-8859-b6b205c94834",
        "Fato Paraları Saçıyor.",
        "Fato " + expense + " TL harcadı."
      );
    }
    res.json({
      success: true,
      expense: newExpenseRows[0],
    });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    conn.release();
  }
});

app.get("/api/delete-expense/:id", async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    // Harcamayı sil
    const [expense] = await conn.execute("SELECT * FROM expenses WHERE id = ?", [id]);
    await conn.execute("DELETE FROM expenses WHERE id = ?", [id]);
    // get last week
    const [lastWeek] = await conn.execute("SELECT * FROM weekly_budget ORDER BY start_date DESC LIMIT 1");
    let spent = lastWeek[0].spent;
    spent -= expense[0].expense;
    // calculate total spent of last week
    await conn.execute("UPDATE weekly_budget SET spent = ? WHERE id = ?", [spent, lastWeek[0].id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    conn.release();
  }
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
