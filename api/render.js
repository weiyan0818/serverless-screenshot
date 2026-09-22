const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

chromium.font("https://raw.githack.com/googlefonts/noto-cjk/main/Sans/OTC/NotoSansCJK-Regular.ttc");

const uploadFromBuffer = (buffer) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "social-images",
        resource_type: "image",
        format: "jpg",
      },
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      }
    );
    uploadStream.write(buffer);
    uploadStream.end();
  });
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { htmlList } = req.body;

  if (!htmlList || !Array.isArray(htmlList) || htmlList.length === 0) {
    return res.status(400).json({ error: '請提供有效的 htmlList 陣列' });
  }

  let browser = null;
  const imageUrls = [];

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1000, height: 1000, deviceScaleFactor: 2 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    for (let i = 0; i < htmlList.length; i++) {
      const htmlContent = htmlList[i];

      await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });

      const buffer = await page.screenshot({ type: 'jpeg', quality: 85 });
      const uploadResult = await uploadFromBuffer(buffer);
      imageUrls.push(uploadResult.secure_url);
    }

    return res.status(200).json({
      success: true,
      count: imageUrls.length,
      images: imageUrls
    });

  } catch (error) {
    console.error('渲染失敗:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
};
