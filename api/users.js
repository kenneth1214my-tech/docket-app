// Admin-only user account management (list/create/update/delete). All
// writes guard against locking the team out entirely: you can't remove or
// demote the last remaining active admin, and you can't delete yourself.
const { requireAdmin, readJsonBody, hashPassword } = require("./_session");
const { getUsers, saveUsers, findUserByEmail, findUserById, nextUserId, publicUser } = require("./_users");

var VALID_ROLES = ["admin", "member"];

function activeAdminCount(users, excludingId) {
  return users.filter(function (u) { return u.role === "admin" && u.active !== false && u.id !== excludingId; }).length;
}

module.exports = async (req, res) => {
  var session = requireAdmin(req, res);
  if (!session) return;

  if (req.method === "GET") {
    try {
      var users = await getUsers();
      res.status(200).json(users.map(publicUser));
    } catch (e) {
      res.status(500).json({ error: "Could not load users: " + (e && e.message ? e.message : String(e)) });
    }
    return;
  }

  var body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: "Invalid request body." });
    return;
  }

  if (req.method === "POST") {
    if (!body || !body.name || !body.email || !body.password) {
      res.status(400).json({ error: "Name, email and password are required." });
      return;
    }
    if (String(body.password).length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters." });
      return;
    }
    var role = VALID_ROLES.indexOf(body.role) !== -1 ? body.role : "member";
    try {
      var users = await getUsers();
      if (findUserByEmail(users, body.email)) {
        res.status(400).json({ error: "A user with that email already exists." });
        return;
      }
      var user = {
        id: nextUserId(),
        name: String(body.name).trim(),
        email: String(body.email).trim().toLowerCase(),
        passwordHash: hashPassword(body.password),
        role: role,
        active: true,
        createdAt: new Date().toISOString()
      };
      users.push(user);
      await saveUsers(users);
      res.status(200).json(publicUser(user));
    } catch (e) {
      res.status(500).json({ error: "Could not create user: " + (e && e.message ? e.message : String(e)) });
    }
    return;
  }

  if (req.method === "PUT") {
    if (!body || !body.id) {
      res.status(400).json({ error: "User id is required." });
      return;
    }
    try {
      var users = await getUsers();
      var target = findUserById(users, body.id);
      if (!target) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      var willBeAdmin = body.role != null ? body.role === "admin" : target.role === "admin";
      var willBeActive = body.active != null ? !!body.active : target.active !== false;
      var losingAdminCoverage = (target.role === "admin" && target.active !== false) && !(willBeAdmin && willBeActive);
      if (losingAdminCoverage && activeAdminCount(users, target.id) === 0) {
        res.status(400).json({ error: "Can't remove the last remaining admin." });
        return;
      }
      if (body.role != null) {
        if (VALID_ROLES.indexOf(body.role) === -1) { res.status(400).json({ error: "Invalid role." }); return; }
        target.role = body.role;
      }
      if (body.active != null) target.active = !!body.active;
      if (body.name) target.name = String(body.name).trim();
      if (body.newPassword) {
        if (String(body.newPassword).length < 6) { res.status(400).json({ error: "Password must be at least 6 characters." }); return; }
        target.passwordHash = hashPassword(body.newPassword);
      }
      await saveUsers(users);
      res.status(200).json(publicUser(target));
    } catch (e) {
      res.status(500).json({ error: "Could not update user: " + (e && e.message ? e.message : String(e)) });
    }
    return;
  }

  if (req.method === "DELETE") {
    if (!body || !body.id) {
      res.status(400).json({ error: "User id is required." });
      return;
    }
    if (body.id === session.sub) {
      res.status(400).json({ error: "You can't delete your own account." });
      return;
    }
    try {
      var users = await getUsers();
      var target = findUserById(users, body.id);
      if (!target) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      if (target.role === "admin" && target.active !== false && activeAdminCount(users, target.id) === 0) {
        res.status(400).json({ error: "Can't remove the last remaining admin." });
        return;
      }
      var next = users.filter(function (u) { return u.id !== body.id; });
      await saveUsers(next);
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "Could not delete user: " + (e && e.message ? e.message : String(e)) });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
