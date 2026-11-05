# Counts jogged junctions and per-route stubs left in site/data/network.json (what tidy_junctions.py cleans up).
import os
import json, math, collections, sys
n=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "data", "network.json")))
E=n["edges"]; L=n["lines"]
LAT0=47.61; KX=111320*math.cos(math.radians(LAT0)); KY=110574
m=lambda c:((c[0]+122.33)*KX,(c[1]-LAT0)*KY)
def length(e):
    p=[m(c) for c in e["c"]]; return sum(math.hypot(p[i+1][0]-p[i][0],p[i+1][1]-p[i][1]) for i in range(len(p)-1))
def key(c): return (round(c[0],6),round(c[1],6))
at=collections.defaultdict(list)
for k,e in enumerate(E):
    at[key(e["c"][0])].append((k,0)); at[key(e["c"][-1])].append((k,1))
def outdir(k,end):
    p=[m(c) for c in E[k]["c"]]
    if end==1: p=p[::-1]
    # direction leaving the node, looking 25 m in
    acc=0; q=p[0]
    for i in range(1,len(p)):
        acc+=math.hypot(p[i][0]-p[i-1][0],p[i][1]-p[i-1][1]); q=p[i]
        if acc>=25: break
    dx,dy=q[0]-p[0][0],q[1]-p[0][1]; d=math.hypot(dx,dy) or 1
    return (dx/d,dy/d)
lens=[length(e) for e in E]
jogs=[]
for k,e in enumerate(E):
    if lens[k]>60: continue
    na,nb=key(e["c"][0]),key(e["c"][-1])
    for r in e["l"]:
        A=[(j,end) for j,end in at[na] if j!=k and r in E[j]["l"]]
        B=[(j,end) for j,end in at[nb] if j!=k and r in E[j]["l"]]
        hit=False
        for a in A:
            for b in B:
                da,db=outdir(*a),outdir(*b)
                if da[0]*db[0]+da[1]*db[1]< -0.8: hit=True
        if hit: jogs.append((k,r)); 
jk=sorted(set(k for k,_ in jogs))
print("jog edges", len(jk))
for k in jk[:15]: print(" ", k, round(lens[k]), E[k]["c"][0])
# route stubs: short edge, far end degree 1 for that route, near end degree>=3
stubs=[]
for k,e in enumerate(E):
    if lens[k]>80: continue
    ends=[key(e["c"][0]),key(e["c"][-1])]
    for r in e["l"]:
        deg=[sum(1 for j,_ in at[x] if r in E[j]["l"]) for x in ends]
        if sorted(deg)[0]==1 and sorted(deg)[1]>=3: stubs.append((k,r))
print("route stubs", len(stubs), "on", len(set(k for k,_ in stubs)), "edges")
for k,r in stubs[:10]: print(" ", k, L[r], round(lens[k]), E[k]["c"][0])
