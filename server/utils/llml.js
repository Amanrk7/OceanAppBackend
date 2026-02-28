import express from 'exprss';
import jwt from 'jsonwebtoken';




// getting all the issue:
app.get('/api/issues', authMiddleWare, adminMiddleWare, async (req, res) => {
    try {
        const issues = await Prisma.issues.findMany({
            orderBy: {
                createdAt: 'desc'
            }
        });

        res.json({ data: issues });
    } catch (err) {
        console.log("Error fetching issues: ", err);
        res.status(500).json({ error: 'Failed to fetch issues' });
    }


});

// creating a new issue:
app.post('/api/issues', authMiddleWare, adminMiddleware, async(req, res) =>{

    const {title, description, status, priority, username, createdAt} = req.body;

    try{
        const newIssue = await Prisma.issue.create({
            data: {
                title: title.trim(), description, status, priority, username, createdAt
            }
        })
    }
})

// updating the issue:
app.post ('/api/issues:issueId/resolve', asyc (req, res) => {

    const {issueId} = req.params;

    const issue = await Prisma.issue.findUnique({
        where: {
            id: parseInt(issueId);
        }
    });

    const resolveIssue = await Prisma.issue.update({
        where: {
            id: parseInt(issueId)
        },
        data: {
            status: 'RESOLVED',
            updatedAt: new Date()
        }
    })
})