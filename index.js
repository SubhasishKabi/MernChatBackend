const express = require("express");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const cors = require("cors");
const User = require("./models/User");
const Message = require("./models/Message");
const app = express();
const ws = require("ws");
const fs = require("fs");

app.use(express.json());
dotenv.config();
app.use(
  cors({
    credentials: true,
    origin: "https://mern-chat-frontend-eta.vercel.app/",
  })
);
app.use(cookieParser());

app.use("/uploads", express.static(__dirname + "/uploads"));

async function getUserDataFromRequest(req) {
  return new Promise((resolve, reject) => {
    const token = req.cookies?.usertoken;
    if (token) {
      jwt.verify(token, process.env.JWT_SECRET, {}, (err, userData) => {
        if (err) {
          throw err;
        }
        // console.log(userData);
        resolve(userData);
      });
    } else {
      // res.status(420).json("no token");
      reject(null);
    }
  });
}

app.get("/profile", (req, res) => {
  // console.log(req)
  // const token = req.cookies?.token;
  // console.log(token);
  const token = req.cookies?.usertoken;
  if (token) {
    jwt.verify(token, process.env.JWT_SECRET, {}, (err, userData) => {
      if (err) {
        throw err;
      }
      // console.log(userData);
      res.json(userData);
    });
  } else {
    // res.status(420).json("no token");
    res.json(null);
  }
});

app.post("/register", async (req, res) => {
  try {
    const { userName, password } = req.body;
    const salt = await bcrypt.genSalt();
    const passwordHash = await bcrypt.hash(password, salt);
    // console.log(userName, password);
    const createdUser = await User.create({ userName, password: passwordHash });
    // console.log(createdUser)

    const token = jwt.sign(
      { id: createdUser._id, userName: createdUser.userName },
      process.env.JWT_SECRET
    );
    // console.log(token);
    const cookieOptions = {
      expires: new Date(
        Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
      ),
      httpOnly: true,
    };

    res.cookie("usertoken", token, cookieOptions);
    res.status(200).json(createdUser);
  } catch (err) {
    console.log(err);
  }
});

app.post("/login", async (req, res) => {
  const { userName, password } = req.body;
  const userDoc = await User.findOne({ userName });
  const isMatch = bcrypt.compare(password, userDoc.password);
  if (!isMatch) return res.status(400).json({ msg: "Invalid credentials" });

  if (userDoc) {
    userDoc.password = undefined;

    const token = jwt.sign(
      { id: userDoc._id, userName: userDoc.userName },
      process.env.JWT_SECRET
    );
    const cookieOptions = {
      expires: new Date(
        Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
      ),
      httpOnly: true,
    };

    res.cookie("usertoken", token, cookieOptions);

    res.status(200).json(userDoc);
  } else {
    res.status(422).json("User not found");
  }
});

app.post("/logout", (req, res) => {
  res.cookie("usertoken", "", "").json(true);
});

app.get("/messages/:userId", async (req, res) => {
  const { userId } = req.params;
  const userData = await getUserDataFromRequest(req);

  const ourUserId = userData.id;
  const messages = await Message.find({
    sender: { $in: [userId, ourUserId] },
    recipient: {
      $in: [userId, ourUserId],
    },
  }).sort({ createdAt: 1 });

  res.json(messages);
});

app.get("/people", async (req, res) => {
  const users = await User.find({}, { _id: 1, userName: 1 });
  // console.log(users)
  res.json(users);
});

const PORT = process.env.PORT || 4000;
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Database connected");
  })
  .catch((error) => console.log(`${error} did not connect`));

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

//--------------------------SOCKET CONNECTION-----------------------------------//

const wss = new ws.WebSocketServer({ server });
wss.on("connection", (connection, req) => {
  // console.log("connected");
  // connection.send("hello");
  // console.log(req.headers)
  // console.log(connection);

  const notifyAboutOnlinePeople = () => {
    [...wss.clients].forEach((client) => {
      client.send(
        JSON.stringify({
          online: [...wss.clients].map((c) => ({
            userId: c.userId,
            userName: c.userName,
          })),
        })
      );
    });
  };

  connection.isAlive = true;
  connection.timer = setInterval(() => {
    connection.ping();
    connection.deathTimer = setTimeout(() => {
      connection.isAlive = false;
      connection.terminate();
      notifyAboutOnlinePeople();
    }, 1000);
  }, 3000);

  connection.on("pong", () => {
    clearTimeout(connection.deathTimer);
  });

  //read username and id from the cookies

  const cookies = req.headers.cookie;
  // console.log(cookies);
  if (cookies) {
    const tokenCookieString = cookies
      .split(";")
      .find((str) => str.startsWith("usertoken="));

    if (tokenCookieString) {
      const token = tokenCookieString.split("=")[1];

      if (token) {
        jwt.verify(token, process.env.JWT_SECRET, {}, (err, userData) => {
          if (err) {
            throw err;
          }
          const { id, userName } = userData;
          // console.log(userData);
          connection.userId = id;
          connection.userName = userName;
          // console.log(connection.userId);
        });
      }
    }
  }

  //notify who are online
  // notifyAboutOnlinePeople();
  [...wss.clients].forEach((client) => {
    client.send(
      JSON.stringify({
        online: [...wss.clients].map((c) => ({
          userId: c.userId,
          userName: c.userName,
        })),
      })
    );
  });

  //sending a message

  connection.on("message", async (message) => {
    // console.log(message);
    messageData = JSON.parse(message.toString());
    const { recipient, text, file } = messageData;
    // console.log({ recipient, text });

    let fileName;

    if (file) {
      // console.log({file});
      const parts = file.name.split(".");
      const ext = parts[parts.length - 1];
      fileName = Date.now() + "." + ext;
      const path = __dirname + "/uploads/" + fileName;
      // const bufferData = new Buffer(file.data, "base64"); //(deprecated)
      const bufferData = Buffer.from(file.data.split(",")[1], "base64");
      // console.log(bufferData);
      fs.writeFile(path, bufferData, () => {
        console.log("file saved");
      });
    }

    if (recipient && (file || text)) {
      const messageDoc = await Message.create({
        sender: connection.userId,
        recipient,
        text,
        file: file ? fileName : null,
      });
      // console.log(messageDoc);
      [...wss.clients]
        .filter((c) => c.userId === recipient)
        .forEach((c) =>
          c.send(
            JSON.stringify({
              text,
              sender: connection.userId,
              recipient,
              _id: messageDoc._id,
              file: file ? fileName : null,
            })
          )
        );
    }
  });
});
